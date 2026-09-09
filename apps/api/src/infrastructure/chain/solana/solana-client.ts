/**
 * The JSON-RPC surface of a Solana node, and nothing else.
 *
 * Split from the gateway for the same reason the TRON client is: the defects that cost money are
 * decoding defects, and separating the transport is what lets recorded responses drive the tests.
 *
 * Read entirely at the `finalized` commitment. Solana offers `processed` and `confirmed` as well,
 * and both move backwards: a block seen at either can be dropped. Reading only what is finalized
 * means the scan never observes a transfer that later stops existing, at the cost of roughly twelve
 * seconds of latency, which for a payment is nothing. It also makes the reorg machinery defensive
 * rather than load-bearing on this chain, and that is a property worth having deliberately rather
 * than discovering.
 */

interface SolanaBlockHeader {
  readonly slot: number;
  readonly blockhash: string;
  readonly previousBlockhash: string;
  readonly parentSlot: number;
  readonly blockTimeMilliseconds: number;
}

/** One account's lamport balance before and after a transaction, by its index in the account list. */
export interface SolanaNativeDelta {
  readonly account: string;
  readonly before: bigint;
  readonly after: bigint;
}

/**
 * One token account's balance before and after, carrying the owner the node itself resolved.
 *
 * The owner is the whole reason this adapter never derives an associated token account. An SPL
 * transfer credits a token account, not the wallet that owns it, so matching on the destination
 * address alone would miss every SPL payment. The node already knows the owner and says so, which
 * is both simpler and more reliable than deriving the address ourselves and hoping the derivation
 * matches what the token program actually used.
 */
export interface SolanaTokenDelta {
  readonly owner: string;
  readonly mint: string;
  readonly before: bigint;
  readonly after: bigint;
}

interface SolanaTransaction {
  readonly signature: string;
  readonly succeeded: boolean;
  readonly nativeDeltas: readonly SolanaNativeDelta[];
  readonly tokenDeltas: readonly SolanaTokenDelta[];
}

export interface SolanaBlock {
  readonly header: SolanaBlockHeader;
  readonly transactions: readonly SolanaTransaction[];
}

class SolanaTransportError extends Error {
  constructor(reason: string) {
    super(`The Solana endpoint could not be reached: ${reason}`);
    this.name = 'SolanaTransportError';
  }
}

/** What the gateway needs, so a test can answer with recorded responses instead of a network. */
export interface SolanaNode {
  readFinalizedSlot(): Promise<number>;
  readGenesisIdentity(): Promise<string>;
  /** The slots that actually produced a block in this range. Solana skips slots routinely. */
  readProducedSlots(fromSlot: number, toSlot: number): Promise<readonly number[]>;
  readBlock(slot: number): Promise<SolanaBlock | null>;
  readSlotOfSignature(signature: string): Promise<number | null>;
  readNativeBalance(account: string): Promise<bigint>;
  readTokenBalance(account: string, mint: string): Promise<bigint>;
}

interface HttpSolanaNodeOptions {
  readonly endpoint: string;
  readonly timeoutMilliseconds?: number;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const FINALIZED = { commitment: 'finalized' } as const;

/**
 * The highest transaction version this client will accept from a node.
 *
 * Not zero, which is what a reading of the documentation suggests and what this originally sent.
 * A node refuses the WHOLE BLOCK when it contains a transaction above the stated version rather
 * than omitting that one transaction, so a single newer transaction anywhere in a block halts
 * scanning for the entire network. Devnet already carries version 1.
 *
 * Set high on purpose. Every field this adapter reads is resolved by the node before it is sent -
 * `accountKeys` already includes addresses loaded from a lookup table, and the balance arrays are
 * indexed to match it - so there is no version whose shape this client would misread. Pinning to
 * the newest version that exists today would only move the outage to the day after the next one
 * ships.
 */
const MAXIMUM_TRANSACTION_VERSION = 255;

const TOO_MANY_REQUESTS = 429;
const THROTTLE_RETRIES = 5;
/**
 * Seconds rather than milliseconds. A public Solana endpoint measures its budget over a window of
 * seconds, so pausing for a fraction of one and trying again simply spends another request against
 * the same exhausted budget. Widening pauses give the window time to roll over.
 */
const THROTTLE_PAUSE_MILLISECONDS = 1000;

/** Solana reports a skipped or pruned slot as an error rather than as an empty result. */
const SLOT_SKIPPED_CODE = -32_009;
const SLOT_NOT_AVAILABLE_CODE = -32_004;
const LONG_TERM_STORAGE_CODE = -32_007;

interface ParsedTokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

function readTokenDeltas(meta: Record<string, unknown>): readonly SolanaTokenDelta[] {
  const before = (meta.preTokenBalances ?? []) as ParsedTokenBalance[];
  const after = (meta.postTokenBalances ?? []) as ParsedTokenBalance[];
  const beforeByAccount = new Map<number, bigint>();
  for (const entry of before) {
    if (entry.accountIndex !== undefined) {
      beforeByAccount.set(entry.accountIndex, BigInt(entry.uiTokenAmount?.amount ?? '0'));
    }
  }

  const deltas: SolanaTokenDelta[] = [];
  for (const entry of after) {
    if (entry.accountIndex === undefined || entry.owner === undefined || entry.mint === undefined) {
      continue;
    }
    deltas.push({
      owner: entry.owner,
      mint: entry.mint,
      // A token account that did not exist before the transaction has no entry in the pre list,
      // which is the ordinary case for a first payment to a fresh destination.
      before: beforeByAccount.get(entry.accountIndex) ?? 0n,
      after: BigInt(entry.uiTokenAmount?.amount ?? '0'),
    });
  }
  return deltas;
}

function readNativeDeltas(
  meta: Record<string, unknown>,
  accounts: readonly string[],
): readonly SolanaNativeDelta[] {
  const before = (meta.preBalances ?? []) as number[];
  const after = (meta.postBalances ?? []) as number[];
  const deltas: SolanaNativeDelta[] = [];
  for (const [index, account] of accounts.entries()) {
    const from = before[index];
    const to = after[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    deltas.push({ account, before: BigInt(from), after: BigInt(to) });
  }
  return deltas;
}

function readAccountKeys(message: Record<string, unknown>): readonly string[] {
  const keys = (message.accountKeys ?? []) as (string | { pubkey?: string })[];
  return keys.map((key) => (typeof key === 'string' ? key : (key.pubkey ?? '')));
}

export function decodeSolanaBlock(slot: number, raw: unknown): SolanaBlock {
  const block = raw as {
    blockhash?: string;
    previousBlockhash?: string;
    parentSlot?: number;
    blockTime?: number;
    transactions?: unknown[];
  };
  if (typeof block.blockhash !== 'string') {
    throw new SolanaTransportError('a block response carried no blockhash');
  }

  const transactions: SolanaTransaction[] = [];
  const rawTransactions = block.transactions ?? [];
  for (const entry of rawTransactions) {
    const item = entry as {
      transaction?: { signatures?: string[]; message?: Record<string, unknown> };
      meta?: Record<string, unknown>;
    };
    const signature = item.transaction?.signatures?.[0];
    if (signature === undefined || item.meta === undefined) {
      continue;
    }
    const accounts = readAccountKeys(item.transaction?.message ?? {});
    transactions.push({
      signature,
      // A failed transaction still pays its fee and still appears in the block. Its balance changes
      // were rolled back, so crediting one would credit money that never moved.
      succeeded: item.meta.err === null || item.meta.err === undefined,
      nativeDeltas: readNativeDeltas(item.meta, accounts),
      tokenDeltas: readTokenDeltas(item.meta),
    });
  }

  return {
    header: {
      slot,
      blockhash: block.blockhash,
      previousBlockhash: block.previousBlockhash ?? '',
      // Solana skips slots, so a block's parent is very often not the slot before it. Following
      // height minus one would read a healthy chain as a fork.
      parentSlot: block.parentSlot ?? slot - 1,
      blockTimeMilliseconds: (block.blockTime ?? 0) * 1000,
    },
    transactions,
  };
}

export class HttpSolanaNode implements SolanaNode {
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;

  constructor(options: HttpSolanaNodeOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  }

  /**
   * A scan reads one block per produced slot, and a public endpoint will rate limit that long
   * before it refuses it outright. Answering 429 by giving up would turn an ordinary throttle into
   * a halted network, so it is retried with a widening pause. The attempts are bounded: an endpoint
   * that is still refusing after them is genuinely unavailable, and the caller needs to know that
   * rather than wait forever.
   */
  private async call(method: string, parameters: readonly unknown[]): Promise<unknown> {
    let response: Response | null = null;
    for (let attempt = 0; attempt <= THROTTLE_RETRIES; attempt += 1) {
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: parameters }),
          signal: AbortSignal.timeout(this.timeoutMilliseconds),
        });
      } catch (error) {
        throw new SolanaTransportError(error instanceof Error ? error.name : 'the request failed');
      }
      if (response.status !== TOO_MANY_REQUESTS) {
        break;
      }
      if (attempt === THROTTLE_RETRIES) {
        throw new SolanaTransportError('the endpoint is rate limiting this client');
      }
      await this.pause(THROTTLE_PAUSE_MILLISECONDS * (attempt + 1));
    }

    if (response === null) {
      throw new SolanaTransportError('the request produced no response');
    }
    if (!response.ok) {
      throw new SolanaTransportError(`the endpoint answered ${response.status}`);
    }

    const body = (await response.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (body.error !== undefined) {
      throw new SolanaTransportError(body.error.message ?? `error ${body.error.code ?? 0}`);
    }
    return body.result;
  }

  private pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async readFinalizedSlot(): Promise<number> {
    return (await this.call('getSlot', [FINALIZED])) as number;
  }

  async readGenesisIdentity(): Promise<string> {
    return (await this.call('getGenesisHash', [])) as string;
  }

  async readProducedSlots(fromSlot: number, toSlot: number): Promise<readonly number[]> {
    return (await this.call('getBlocks', [fromSlot, toSlot, FINALIZED])) as number[];
  }

  async readBlock(slot: number): Promise<SolanaBlock | null> {
    try {
      const raw = await this.call('getBlock', [
        slot,
        {
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: MAXIMUM_TRANSACTION_VERSION,
          rewards: false,
          commitment: 'finalized',
        },
      ]);
      if (raw === null) {
        return null;
      }
      return decodeSolanaBlock(slot, raw);
    } catch (error) {
      if (error instanceof SolanaTransportError && isSkippedSlotMessage(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async readSlotOfSignature(signature: string): Promise<number | null> {
    const statuses = (await this.call('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ])) as { value?: ({ slot?: number; confirmationStatus?: string } | null)[] };
    const status = statuses.value?.[0];
    if (status?.slot === undefined) {
      return null;
    }
    return status.slot;
  }

  async readNativeBalance(account: string): Promise<bigint> {
    const balance = (await this.call('getBalance', [account, FINALIZED])) as { value?: number };
    return BigInt(balance.value ?? 0);
  }

  async readTokenBalance(account: string, mint: string): Promise<bigint> {
    const accounts = (await this.call('getTokenAccountsByOwner', [
      account,
      { mint },
      { encoding: 'jsonParsed', commitment: 'finalized' },
    ])) as {
      value?: {
        account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } };
      }[];
    };

    let total = 0n;
    const tokenAccounts = accounts.value ?? [];
    for (const entry of tokenAccounts) {
      total += BigInt(entry.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0');
    }
    return total;
  }
}

/**
 * A skipped slot is reported as an error, not as an absent result, and the distinction between
 * "this slot produced nothing" and "this endpoint is unwell" decides whether scanning continues or
 * halts. Matched on the documented error codes rather than on message text.
 */
function isSkippedSlotMessage(message: string): boolean {
  return (
    message.includes(String(SLOT_SKIPPED_CODE)) ||
    message.includes(String(SLOT_NOT_AVAILABLE_CODE)) ||
    message.includes(String(LONG_TERM_STORAGE_CODE)) ||
    message.includes('was skipped') ||
    message.includes('missing due to ledger jump')
  );
}
