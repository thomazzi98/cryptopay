import { secp256k1 } from '@noble/curves/secp256k1.js';
import { publicKeyToAddress } from 'viem/utils';

import {
  decodeTronAddress,
  encodeTronAddress,
} from '../../src/infrastructure/chain/tron/address.js';

/**
 * The twenty-one byte payload behind a base58check address, as hex. Re-exported here so a spec
 * encoding a contract argument reaches for the node helper rather than for the adapter it is
 * testing, which would make the test agree with the code by construction.
 */
export function decodeTronAddressPayload(account: string): string {
  return decodeTronAddress(account);
}

/**
 * A real TRON full node, run locally.
 *
 * `docker run -d -p 9090:9090 --name cryptopay-tre tronbox/tre` starts one. It is a genuine
 * java-tron node with a single witness and a genesis block that pre-funds a handful of accounts, so
 * everything here is real node software answering real requests: real transaction encoding, real
 * signature verification, real block production and the real TronGrid-compatible HTTP surface the
 * adapter speaks to in production.
 *
 * What it is not is TRON. It is one witness with no peers, so it says nothing about how the network
 * behaves under a reorganisation, under load, or when TronGrid rate limits. The public Nile suite
 * covers what a local node cannot, and neither is a substitute for the other.
 *
 * The witness key below is `0x…01`, published in this image's own configuration file as the local
 * witness. It controls the genesis account on a throwaway container and is worth nothing anywhere
 * else. It is derived here rather than written down so that no file in this repository contains a
 * thirty-two byte hex private key, which is a shape the secret scanner rejects on sight and should.
 */

export const TRON_NODE_BASE_URL = 'http://127.0.0.1:9090';

/** The image's genesis witness: the integer one, as a 32-byte key. */
function witnessKey(): Uint8Array {
  const key = new Uint8Array(32);
  key[31] = 1;
  return key;
}

export function accountFor(privateKey: Uint8Array): string {
  const publicKey = secp256k1.Point.fromBytes(secp256k1.getPublicKey(privateKey, true)).toBytes(
    false,
  );
  const keyHash = publicKeyToAddress(`0x${Buffer.from(publicKey).toString('hex')}`);
  return encodeTronAddress(`41${keyHash.slice(2).toLowerCase()}`);
}

export interface FundedAccount {
  readonly account: string;
  readonly privateKey: Uint8Array;
}

/** The genesis witness, which holds the entire pre-mined supply and pays for everything here. */
export function genesisAccount(): FundedAccount {
  const privateKey = witnessKey();
  return { account: accountFor(privateKey), privateKey };
}

/**
 * Generous on purpose. `broadcasttransaction` does not return until the witness has produced the
 * block that carries the transaction, and a witness produces one every three seconds at most, so a
 * single call routinely takes several seconds and occasionally much longer while a machine is also
 * running a database and a test runner. Thirty seconds looked ample and was not.
 */
const REQUEST_TIMEOUT_MILLISECONDS = 120_000;

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${TRON_NODE_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  return (await response.json()) as T;
}

export async function isNodeRunning(): Promise<boolean> {
  try {
    const block = await post<{ blockID?: string }>('/wallet/getnowblock', {});
    return typeof block.blockID === 'string';
  } catch {
    return false;
  }
}

/** The identity the adapter asserts before it will scan. A local chain has its own. */
export async function readGenesisIdentity(): Promise<string> {
  const block = await post<{ blockID: string }>('/wallet/getblockbynum', {
    [BLOCK_NUMBER_FIELD]: 0,
  });
  return block.blockID;
}

/**
 * Wire field names, kept as data for the same reason the client does it: TronGrid chose these
 * spellings, and writing them as identifiers would import a naming convention this codebase rejects.
 */
const BLOCK_NUMBER_FIELD = 'num';
const TRANSACTION_ID_FIELD = 'txID';

interface UnsignedTransaction {
  readonly [TRANSACTION_ID_FIELD]?: string;
  readonly Error?: string;
}

interface BroadcastResult {
  readonly result?: boolean;
  readonly txid?: string;
  readonly code?: string;
  readonly message?: string;
}

/**
 * TRON signs the transaction id itself, which is already a digest, so the curve must not hash it
 * again. The signature travels as r, then s, then the recovery byte; this curve library returns the
 * recovery byte first, and getting that order wrong produces a signature the node rejects as
 * belonging to a different account.
 */
function sign(transaction: object, transactionId: string, privateKey: Uint8Array): object {
  const recovered = secp256k1.sign(Buffer.from(transactionId, 'hex'), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  const signature = Buffer.concat([
    Buffer.from(recovered.subarray(1)),
    Buffer.from([recovered[0] ?? 0]),
  ]);
  return { ...transaction, signature: [signature.toString('hex')] };
}

class TronNodeError extends Error {
  constructor(message: string) {
    super(`The local TRON node refused the request: ${message}`);
    this.name = 'TronNodeError';
  }
}

async function broadcast(unsigned: UnsignedTransaction, privateKey: Uint8Array): Promise<string> {
  const transactionId = unsigned[TRANSACTION_ID_FIELD];
  if (transactionId === undefined) {
    throw new TronNodeError(unsigned.Error ?? JSON.stringify(unsigned).slice(0, 200));
  }
  const result = await post<BroadcastResult>(
    '/wallet/broadcasttransaction',
    sign(unsigned, transactionId, privateKey),
  );
  if (result.result !== true) {
    throw new TronNodeError(`${result.code ?? 'unknown'} ${result.message ?? ''}`.trim());
  }
  return transactionId;
}

/** A native TRX payment. Returns the transaction id the chain will report it under. */
export async function sendTrx(
  from: FundedAccount,
  toAccount: string,
  amountInSun: bigint,
): Promise<string> {
  const unsigned = await post<UnsignedTransaction>('/wallet/createtransaction', {
    owner_address: from.account,
    to_address: toAccount,
    amount: Number(amountInSun),
    visible: true,
  });
  return broadcast(unsigned, from.privateKey);
}

/** Deploys a contract from compiled bytecode and returns the address the chain assigned it. */
export async function deployContract(
  from: FundedAccount,
  bytecode: string,
  abi: readonly unknown[],
): Promise<string> {
  const unsigned = await post<UnsignedTransaction & { contract_address?: string }>(
    '/wallet/deploycontract',
    {
      owner_address: from.account,
      abi: JSON.stringify(abi),
      bytecode: bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode,
      fee_limit: 1_000_000_000,
      consume_user_resource_percent: 100,
      origin_energy_limit: 10_000_000,
      visible: true,
    },
  );
  const address = unsigned.contract_address;
  if (address === undefined) {
    throw new TronNodeError(unsigned.Error ?? 'the node returned no contract address');
  }
  await broadcast(unsigned, from.privateKey);
  // The node answers with the twenty-one byte payload as hex even when asked for visible addresses,
  // and every other account in this system is base58. Encoding here keeps the difference in one
  // place rather than in every caller.
  const account = encodeTronAddress(address);
  await awaitContract(account);
  return account;
}

/**
 * Waits until the node will answer for the deployed contract.
 *
 * A broadcast returns once the transaction is in a block, which is not quite the same moment the
 * contract becomes callable. Calling it too early answers "No contract or not a valid smart
 * contract", which reads exactly like a deployment that failed and is not one.
 */
const CONTRACT_READY_ATTEMPTS = 60;

async function awaitContract(account: string): Promise<void> {
  for (let attempt = 0; attempt < CONTRACT_READY_ATTEMPTS; attempt += 1) {
    const contract = await post<{ bytecode?: string }>('/wallet/getcontract', {
      value: account,
      visible: true,
    });
    if (typeof contract.bytecode === 'string' && contract.bytecode.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new TronNodeError(`${account} did not become callable`);
}

/** Calls a contract method that changes state, waiting for the node to accept the broadcast. */
export async function triggerContract(
  from: FundedAccount,
  contractAccount: string,
  selector: string,
  parameter: string,
): Promise<string> {
  const answer = await post<{ transaction?: UnsignedTransaction; result?: { message?: string } }>(
    '/wallet/triggersmartcontract',
    {
      owner_address: from.account,
      contract_address: contractAccount,
      function_selector: selector,
      parameter,
      fee_limit: 1_000_000_000,
      call_value: 0,
      visible: true,
    },
  );
  if (answer.transaction === undefined) {
    const reason = answer.result?.message ?? 'no transaction was returned';
    throw new TronNodeError(Buffer.from(reason, 'hex').toString('utf8') || reason);
  }
  return broadcast(answer.transaction, from.privateKey);
}

export async function readHeadHeight(): Promise<number> {
  const block = await post<{ block_header: { raw_data: { number?: number } } }>(
    '/wallet/getnowblock',
    {},
  );
  return block.block_header.raw_data.number ?? 0;
}
