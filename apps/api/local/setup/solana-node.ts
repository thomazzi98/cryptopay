import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

/**
 * Enough Solana to send a real transfer, without taking on the web3 SDK.
 *
 * The adapter under test speaks raw JSON-RPC on purpose, and adding a large client library so the
 * tests can speak something else would put a second, differently-behaved implementation of the same
 * protocol in the repository. What is actually needed is one instruction from the System Program and
 * the legacy message encoding, which is small enough to write out and read.
 *
 * A legacy message is: a three byte header, a compact array of account keys, the recent blockhash,
 * then a compact array of instructions. Signatures go in front of it. The one subtlety that bites is
 * ordering: writable-signer keys first, then writable, then read-only, and the header counts have to
 * agree with that order or the runtime rejects the transaction as malformed.
 */

/** Solana named this field, not this codebase, so it is data rather than an identifier. */
const FAILURE_FIELD = 'err';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TRANSFER_INSTRUCTION = 2;
const SIGNATURE_BYTES = 64;

export interface SolanaKeypair {
  readonly account: string;
  readonly secretKey: Uint8Array;
}

export function randomKeypair(): SolanaKeypair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { account: base58.encode(ed25519.getPublicKey(secretKey)), secretKey };
}

class SolanaNodeError extends Error {
  constructor(message: string) {
    super(`The Solana node refused the request: ${message}`);
    this.name = 'SolanaNodeError';
  }
}

export class SolanaTestNode {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, parameters: readonly unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: parameters }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error !== undefined) {
      throw new SolanaNodeError(body.error.message ?? method);
    }
    return body.result as T;
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.call<{ 'solana-core': string }>('getVersion', []);
      return true;
    } catch {
      return false;
    }
  }

  async genesisIdentity(): Promise<string> {
    return this.call<string>('getGenesisHash', []);
  }

  async balance(account: string): Promise<bigint> {
    const answer = await this.call<{ value: number }>('getBalance', [
      account,
      { commitment: 'confirmed' },
    ]);
    return BigInt(answer.value);
  }

  async airdrop(account: string, lamports: bigint): Promise<string> {
    return this.call<string>('requestAirdrop', [account, Number(lamports)]);
  }

  async latestBlockhash(): Promise<string> {
    const answer = await this.call<{ value: { blockhash: string } }>('getLatestBlockhash', [
      { commitment: 'finalized' },
    ]);
    return answer.value.blockhash;
  }

  async finalizedSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: 'finalized' }]);
  }

  /** Broadcasts and waits until the signature is finalized, so a test never races the validator. */
  async sendAndFinalize(transaction: Uint8Array): Promise<string> {
    const signature = await this.call<string>('sendTransaction', [
      Buffer.from(transaction).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    await this.awaitFinalized(signature);
    return signature;
  }

  async awaitFinalized(signature: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const answer = await this.call<{
        value: readonly ({ confirmationStatus?: string; [FAILURE_FIELD]: unknown } | null)[];
      }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = answer.value[0];
      const failure = status?.[FAILURE_FIELD];
      if (failure !== null && failure !== undefined) {
        throw new SolanaNodeError(`the transaction failed: ${JSON.stringify(failure)}`);
      }
      if (status?.confirmationStatus === 'finalized') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new SolanaNodeError(`${signature} was not finalized in time`);
  }

  async transferLamports(
    from: SolanaKeypair,
    toAccount: string,
    lamports: bigint,
  ): Promise<string> {
    const message = buildTransferMessage(
      from.account,
      toAccount,
      lamports,
      await this.latestBlockhash(),
    );
    return this.sendAndFinalize(signTransaction(message, from));
  }
}

/** Solana's compact-u16: seven bits per byte, high bit continues. */
function compactLength(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const chunk = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      bytes.push(chunk);
      return Uint8Array.from(bytes);
    }
    bytes.push(chunk | 0x80);
  }
}

function transferData(lamports: bigint): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER_INSTRUCTION, true);
  view.setBigUint64(4, lamports, true);
  return data;
}

/**
 * Account order is the part that has to be exactly right: the signer and payer first, then the
 * writable recipient, then the read-only program. The header counts describe that layout, and a
 * mismatch is rejected by the runtime rather than by anything that would say why.
 */
function buildTransferMessage(
  fromAccount: string,
  toAccount: string,
  lamports: bigint,
  recentBlockhash: string,
): Uint8Array {
  const keys = [fromAccount, toAccount, SYSTEM_PROGRAM].map((key) => base58.decode(key));
  const data = transferData(lamports);

  return Buffer.concat([
    // One required signature, no read-only signers, one read-only unsigned account (the program).
    Uint8Array.from([1, 0, 1]),
    compactLength(keys.length),
    ...keys,
    base58.decode(recentBlockhash),
    compactLength(1),
    // Program at index 2, touching accounts 0 and 1, with the transfer payload.
    Uint8Array.from([2]),
    compactLength(2),
    Uint8Array.from([0, 1]),
    compactLength(data.length),
    data,
  ]);
}

function signTransaction(message: Uint8Array, signer: SolanaKeypair): Uint8Array {
  const signature = ed25519.sign(message, signer.secretKey);
  if (signature.length !== SIGNATURE_BYTES) {
    throw new SolanaNodeError('an ed25519 signature must be sixty-four bytes');
  }
  return Buffer.concat([compactLength(1), signature, message]);
}
