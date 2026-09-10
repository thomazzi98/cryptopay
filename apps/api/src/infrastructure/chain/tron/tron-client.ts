import { decodeTronAddress } from './address.js';

/**
 * The HTTP surface of a TRON node, and nothing else.
 *
 * Split from the gateway so the decoding that turns a TronGrid response into a ledger observation
 * can be driven by recorded responses in a unit test, with no network and no clock. Every defect
 * this adapter can have that costs money is a decoding defect, and decoding is what that split makes
 * testable.
 *
 * TronGrid answers on two paths that differ in one important way. `/wallet` reports the head, which
 * can still be reorganised; `/walletsolidity` reports the solidified head, which two thirds of the
 * super representatives have confirmed and which does not move again. That is a real finality tag,
 * so TRON fits the same completion gate as Polygon rather than needing a second one.
 */

export interface TronBlockHeader {
  readonly number: number;
  readonly blockId: string;
  readonly parentHash: string;
  readonly timestamp: number;
}

interface TronContractCall {
  readonly type: string;
  readonly ownerAddressHex: string;
  readonly toAddressHex: string | null;
  readonly amount: bigint | null;
  readonly contractAddressHex: string | null;
}

export interface TronTransaction {
  readonly transactionId: string;
  readonly succeeded: boolean;
  readonly contract: TronContractCall | null;
}

export interface TronBlock {
  readonly header: TronBlockHeader;
  readonly transactions: readonly TronTransaction[];
}

export interface TronEventLog {
  readonly transactionId: string;
  readonly logIndex: number;
  readonly contractAddressHex: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly succeeded: boolean;
}

export class TronTransportError extends Error {
  constructor(reason: string) {
    super(`The TRON endpoint could not be reached: ${reason}`);
    this.name = 'TronTransportError';
  }
}

/** What the gateway needs from a node, so a test can supply recorded answers instead of a network. */
export interface TronNode {
  readHead(): Promise<TronBlockHeader>;
  readSolidifiedHead(): Promise<TronBlockHeader>;
  /** The genesis block identifier, which is what TRON has instead of a numeric chain identity. */
  readGenesisIdentity(): Promise<string>;
  readBlock(height: number): Promise<TronBlock | null>;
  readBlockRange(fromHeight: number, toHeight: number): Promise<readonly TronBlock[]>;
  readBlockEvents(height: number): Promise<readonly TronEventLog[]>;
  readTransaction(transactionId: string): Promise<{ readonly blockHeight: number } | null>;
  readNativeBalance(address: string): Promise<bigint>;
  readTokenBalance(address: string, contractAddress: string): Promise<bigint>;
}

interface HttpTronNodeOptions {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly timeoutMilliseconds?: number;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 12_000;

/**
 * Field names TronGrid defines, written as data rather than as identifiers.
 *
 * The protocol calls these `num`, `startNum` and `endNum`. They are abbreviations this repository
 * bans in its own code, and rightly, but they are not this repository's names to choose: renaming
 * them would produce a request TronGrid does not understand. Naming them here keeps the ban intact
 * everywhere it applies and puts the foreign vocabulary in one visible place.
 */
const BLOCK_NUMBER_FIELD = 'num';
const RANGE_START_FIELD = 'startNum';
const RANGE_END_FIELD = 'endNum';

/** Response fields, named for the same reason: TronGrid chose these spellings, not this codebase. */
const TRANSACTION_ID_FIELD = 'txID';
const RESULT_FIELD = 'ret';
const CONTRACT_RESULT_FIELD = 'contractRet';

function decodeHeader(raw: unknown): TronBlockHeader {
  const block = raw as {
    blockID?: string;
    block_header?: { raw_data?: { number?: number; parentHash?: string; timestamp?: number } };
  };
  const rawData = block.block_header?.raw_data;
  if (rawData === undefined || typeof block.blockID !== 'string') {
    throw new TronTransportError('a block response carried no identifier');
  }
  return {
    // The genesis block omits `number` entirely rather than reporting zero.
    number: rawData.number ?? 0,
    blockId: block.blockID.toLowerCase(),
    parentHash: (rawData.parentHash ?? '').toLowerCase(),
    timestamp: rawData.timestamp ?? 0,
  };
}

function decodeContract(raw: unknown): TronContractCall | null {
  const contract = (raw as { raw_data?: { contract?: unknown[] } }).raw_data?.contract?.[0] as
    | {
        type?: string;
        parameter?: {
          value?: {
            owner_address?: string;
            to_address?: string;
            amount?: number;
            contract_address?: string;
          };
        };
      }
    | undefined;
  if (contract?.type === undefined) {
    return null;
  }
  const value = contract.parameter?.value ?? {};
  return {
    type: contract.type,
    ownerAddressHex: (value.owner_address ?? '').toLowerCase(),
    toAddressHex: value.to_address === undefined ? null : value.to_address.toLowerCase(),
    amount: value.amount === undefined ? null : BigInt(value.amount),
    contractAddressHex:
      value.contract_address === undefined ? null : value.contract_address.toLowerCase(),
  };
}

function decodeTransaction(raw: unknown): TronTransaction {
  const transaction = raw as Record<string, unknown>;
  const identifier = transaction[TRANSACTION_ID_FIELD];
  const results = transaction[RESULT_FIELD];
  const firstResult = (Array.isArray(results) ? results[0] : undefined) as
    Record<string, unknown> | undefined;

  return {
    transactionId: (typeof identifier === 'string' ? identifier : '').toLowerCase(),
    // A reverted transfer still occupies a block. Crediting one would credit money that never moved.
    succeeded: firstResult?.[CONTRACT_RESULT_FIELD] === 'SUCCESS',
    contract: decodeContract(raw),
  };
}

function decodeBlock(raw: unknown): TronBlock {
  const block = raw as { transactions?: unknown[] };
  return {
    header: decodeHeader(raw),
    transactions: (block.transactions ?? []).map((transaction) => decodeTransaction(transaction)),
  };
}

function decodeEvents(raw: unknown): readonly TronEventLog[] {
  const infos = Array.isArray(raw) ? raw : [];
  const events: TronEventLog[] = [];
  for (const info of infos) {
    const entry = info as {
      id?: string;
      receipt?: { result?: string };
      log?: { address?: string; topics?: string[]; data?: string }[];
    };
    // A contract call that ran out of energy or reverted still emits a receipt. Its logs, if any,
    // describe work that was rolled back.
    const succeeded = entry.receipt?.result === 'SUCCESS';
    const logs = entry.log ?? [];
    for (const [logIndex, log] of logs.entries()) {
      events.push({
        transactionId: (entry.id ?? '').toLowerCase(),
        logIndex,
        contractAddressHex: (log.address ?? '').toLowerCase(),
        topics: (log.topics ?? []).map((topic) => topic.toLowerCase()),
        data: (log.data ?? '').toLowerCase(),
        succeeded,
      });
    }
  }
  return events;
}

/** TronGrid reports a failure in the body of an otherwise successful response, under this key. */
const ERROR_FIELD = 'Error';

/**
 * Refuses a body that carries TronGrid's own error, however healthy the HTTP status looked.
 *
 * Every read here degrades an unrecognised body into a benign negative: no block at this height, no
 * events in this block, the chain does not know this transaction, the account holds nothing. Each of
 * those is a legitimate answer the scanner and the reconciler act on. An endpoint that fails while
 * answering 200 therefore became "there is no payment here", which is the one translation this
 * system must never make: a window would be scanned as empty and the cursor advanced past it, or a
 * credited transfer would be withdrawn as orphaned because the node that could confirm it was the
 * one that failed.
 *
 * Throwing instead leaves the cursor where it was and the credit where it was, which is what "cannot
 * determine, do not guess" means on this path.
 */
function assertNoInBodyError(path: string, body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return;
  }
  const reported = (body as Record<string, unknown>)[ERROR_FIELD];
  if (typeof reported !== 'string' || reported.length === 0) {
    return;
  }
  // The endpoint is named and the message is not, because it is attacker-influenced on some paths
  // and this string reaches a log.
  throw new TronTransportError(`${path} answered with an error body`);
}

export class HttpTronNode implements TronNode {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMilliseconds: number;

  constructor(options: HttpTronNodeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== null) {
      headers['TRON-PRO-API-KEY'] = this.apiKey;
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch (error) {
      throw new TronTransportError(error instanceof Error ? error.name : 'the request failed');
    }
    if (!response.ok) {
      throw new TronTransportError(`the endpoint answered ${response.status}`);
    }
    const answered: unknown = await response.json();
    assertNoInBodyError(path, answered);
    return answered;
  }

  async readHead(): Promise<TronBlockHeader> {
    return decodeHeader(await this.call('/wallet/getnowblock', {}));
  }

  async readSolidifiedHead(): Promise<TronBlockHeader> {
    return decodeHeader(await this.call('/walletsolidity/getnowblock', {}));
  }

  async readGenesisIdentity(): Promise<string> {
    const genesis = await this.call('/wallet/getblockbynum', { [BLOCK_NUMBER_FIELD]: 0 });
    return decodeHeader(genesis).blockId;
  }

  async readBlock(height: number): Promise<TronBlock | null> {
    const raw = await this.call('/wallet/getblockbynum', { [BLOCK_NUMBER_FIELD]: height });
    // A height above the head answers with an empty object rather than an error.
    if (typeof (raw as { blockID?: string }).blockID !== 'string') {
      return null;
    }
    return decodeBlock(raw);
  }

  async readBlockRange(fromHeight: number, toHeight: number): Promise<readonly TronBlock[]> {
    const raw = await this.call('/wallet/getblockbylimitnext', {
      [RANGE_START_FIELD]: fromHeight,
      // The endpoint treats the end as exclusive, so a single block needs a range of two.
      [RANGE_END_FIELD]: toHeight + 1,
    });
    const blocks = (raw as { block?: unknown[] }).block ?? [];
    return blocks.map((block) => decodeBlock(block));
  }

  async readBlockEvents(height: number): Promise<readonly TronEventLog[]> {
    const raw = await this.call('/wallet/gettransactioninfobyblocknum', {
      [BLOCK_NUMBER_FIELD]: height,
    });
    return decodeEvents(raw);
  }

  async readTransaction(transactionId: string): Promise<{ readonly blockHeight: number } | null> {
    const raw = await this.call('/wallet/gettransactioninfobyid', { value: transactionId });
    const blockNumber = (raw as { blockNumber?: number }).blockNumber;
    return blockNumber === undefined ? null : { blockHeight: blockNumber };
  }

  async readNativeBalance(address: string): Promise<bigint> {
    const raw = await this.call('/wallet/getaccount', { address, visible: true });
    const balance = (raw as { balance?: number }).balance;
    return BigInt(balance ?? 0);
  }

  async readTokenBalance(address: string, contractAddress: string): Promise<bigint> {
    // The ABI argument is the twenty byte key hash left padded to thirty two, not the base58 string
    // and not the twenty-one byte payload: the leading 0x41 is TRON's address prefix, not part of
    // the value the contract compares against.
    const keyHash = decodeTronAddress(address).slice(2);
    const raw = await this.call('/wallet/triggerconstantcontract', {
      owner_address: address,
      contract_address: contractAddress,
      function_selector: 'balanceOf(address)',
      parameter: keyHash.padStart(64, '0'),
      visible: true,
    });
    const result = (raw as { constant_result?: string[] }).constant_result?.[0];
    if (result === undefined || result === '') {
      return 0n;
    }
    return BigInt(`0x${result}`);
  }
}
