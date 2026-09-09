import {
  associatedTokenAccount,
  buildMessage,
  createAccountInstruction,
  createAssociatedTokenAccountInstruction,
  initializeMintInstruction,
  MINT_ACCOUNT_BYTES,
  mintToInstruction,
  randomKeypair,
  signTransaction,
  TOKEN_PROGRAM,
  transferLamportsInstruction,
  transferTokenInstruction,
  type Instruction,
  type Keypair,
} from './solana-transactions.js';

/**
 * A real Solana validator, spoken to over the same JSON-RPC surface the adapter uses.
 *
 * `docker run -d -p 8899:8899 anzaxyz/agave:v2.1.14 agave-test-validator` starts one. It is a single
 * node reaching its own consensus with nobody to disagree, so nothing here exercises a skipped slot,
 * a fork, or how a public endpoint behaves under rate limiting. Everything else is real: the
 * validator deserialises the transactions, verifies the ed25519 signatures, runs the SPL Token
 * program and finalises the slots.
 */

export type SolanaKeypair = Keypair;

class SolanaNodeError extends Error {
  constructor(message: string) {
    super(`The Solana node refused the request: ${message}`);
    this.name = 'SolanaNodeError';
  }
}

const FINALISATION_ATTEMPTS = 180;
const POLL_INTERVAL_MILLISECONDS = 1000;

/** Solana named this field, not this codebase, so it is data rather than an identifier. */
const FAILURE_FIELD = 'err';

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
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error !== undefined) {
      throw new SolanaNodeError(`${method}: ${body.error.message ?? 'no message'}`);
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

  async tokenBalance(account: string): Promise<bigint> {
    const answer = await this.call<{ value: { amount: string } }>('getTokenAccountBalance', [
      account,
      { commitment: 'confirmed' },
    ]);
    return BigInt(answer.value.amount);
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

  async rentExemptLamports(space: number): Promise<bigint> {
    return BigInt(await this.call<number>('getMinimumBalanceForRentExemption', [space]));
  }

  async awaitFinalized(signature: string): Promise<void> {
    for (let attempt = 0; attempt < FINALISATION_ATTEMPTS; attempt += 1) {
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
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLISECONDS));
    }
    throw new SolanaNodeError(`${signature} was not finalized in time`);
  }

  /**
   * Builds, signs, broadcasts and waits for finalisation, so no test races the validator. Scanning
   * reads finalized slots only, so a transfer that is merely confirmed is one the system is correct
   * to be unable to see yet.
   */
  async send(
    payer: Keypair,
    instructions: readonly Instruction[],
    extraSigners: readonly Keypair[] = [],
  ): Promise<string> {
    const built = buildMessage(payer.account, instructions, await this.latestBlockhash());
    const wire = signTransaction(built, [payer, ...extraSigners]);
    const signature = await this.call<string>('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    await this.awaitFinalized(signature);
    return signature;
  }

  async transferLamports(from: Keypair, toAccount: string, lamports: bigint): Promise<string> {
    return this.send(from, [transferLamportsInstruction(from.account, toAccount, lamports)]);
  }

  /**
   * Creates an SPL mint and returns its address.
   *
   * Two instructions in one transaction, which is how it is always done: the account has to exist
   * and be owned by the token program before that program will initialise it, and splitting them
   * leaves a funded account another transaction could claim in between.
   */
  async createMint(payer: Keypair, decimals: number): Promise<string> {
    const mint = randomKeypair();
    await this.send(
      payer,
      [
        createAccountInstruction({
          payer: payer.account,
          created: mint.account,
          lamports: await this.rentExemptLamports(MINT_ACCOUNT_BYTES),
          space: MINT_ACCOUNT_BYTES,
          owner: TOKEN_PROGRAM,
        }),
        initializeMintInstruction({
          mint: mint.account,
          decimals,
          mintAuthority: payer.account,
        }),
      ],
      [mint],
    );
    return mint.account;
  }

  /** Creates the associated token account for an owner, and returns its address. */
  async createTokenAccount(payer: Keypair, owner: string, mint: string): Promise<string> {
    const account = associatedTokenAccount(owner, mint);
    await this.send(payer, [
      createAssociatedTokenAccountInstruction({
        payer: payer.account,
        associatedAccount: account,
        owner,
        mint,
      }),
    ]);
    return account;
  }

  async mintTo(
    authority: Keypair,
    mint: string,
    destination: string,
    amount: bigint,
  ): Promise<string> {
    return this.send(authority, [
      mintToInstruction({ mint, destination, authority: authority.account, amount }),
    ]);
  }

  /**
   * Sends tokens to a wallet, creating the recipient's associated account first when it has none.
   *
   * Both instructions ride in one transaction because that is what a wallet does, and because it is
   * the case the adapter has to get right: what is credited is a token account, and the owner the
   * node reports for it is the wallet the payment belongs to.
   */
  async transferToken(
    from: Keypair,
    sourceAccount: string,
    ownerAccount: string,
    mint: string,
    amount: bigint,
  ): Promise<string> {
    const destination = associatedTokenAccount(ownerAccount, mint);
    return this.send(from, [
      createAssociatedTokenAccountInstruction({
        payer: from.account,
        associatedAccount: destination,
        owner: ownerAccount,
        mint,
      }),
      transferTokenInstruction({
        source: sourceAccount,
        destination,
        owner: from.account,
        amount,
      }),
    ]);
  }
}
