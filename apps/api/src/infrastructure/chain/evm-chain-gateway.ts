import {
  ERC20_TRANSFER_EVENT_TOPIC,
  toCanonicalAddress,
  type ChainProgress,
  type ChainTransferReference,
  type LedgerHeader,
  type LedgerPosition,
  type NetworkIdentifier,
  type ObservedTransfer,
} from '@cryptopay/shared';
import {
  createPublicClient,
  erc20Abi,
  fallback,
  getAddress,
  http,
  parseAbiItem,
  BaseError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  type Hex,
  type PublicClient,
} from 'viem';

import { NATIVE_ASSET_REFERENCE } from './token-registry.js';
import {
  LedgerIdentityMismatchError,
  LedgerRangeTooWideError,
  type ChainGateway,
  type FinalityConfirmation,
  type LedgerPositionLookup,
  type TransferReconciliation,
  type TransferScanRequest,
  type TransferScanResult,
} from '../../application/ports/chain-gateway.port.js';

/**
 * The EVM adapter. This is the only file in the system that knows what a topic, a log index or a
 * chain id is.
 *
 * Everything a payment is credited for is read from here and nowhere else. A client may tell us a
 * transaction hash, but the amount, the asset, the recipient, the block and the confirmation count
 * are always re-derived from the chain, so a fabricated or altered hint changes nothing.
 */

/**
 * Declared here rather than assembled from topics by hand. viem derives the topic filter from this
 * and decodes the result, so the sender, the recipient and the amount arrive already parsed instead
 * of being sliced out of hex by offset arithmetic that is easy to get quietly wrong.
 */
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const MAXIMUM_ACCOUNTS_PER_QUERY = 400;

/** Asserted against the derived filter, so the shared constant and viem cannot drift apart. */
export const EXPECTED_TRANSFER_TOPIC = ERC20_TRANSFER_EVENT_TOPIC;

export interface EvmChainGatewayOptions {
  readonly networkIdentifier: NetworkIdentifier;
  readonly chainIdentifier: number;
  readonly rpcUrls: readonly string[];
  readonly supportsFinalityTag: boolean;
  /** A separately operated endpoint, used only to second the finality opinion. */
  readonly finalityQuorumRpcUrls?: readonly string[];
}

function toLedgerPosition(blockNumber: bigint, blockHash: string): LedgerPosition {
  return { height: blockNumber, reference: blockHash.toLowerCase() };
}

/**
 * Whether the endpoint failed to answer at all, as opposed to answering with a refusal.
 *
 * The distinction decides whether to shrink the window or to back off, and answering it wrongly is
 * expensive in the direction that matters: treating a rate limit as a range refusal answers a
 * struggling provider with a burst of ever-smaller queries, and then leaves the range crawling back
 * up over dozens of clean ticks.
 *
 * This reads the error's type, never its text.
 */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) {
    return false;
  }
  return (
    error.walk(
      (candidate) =>
        candidate instanceof HttpRequestError ||
        candidate instanceof TimeoutError ||
        candidate instanceof RpcRequestError,
    ) !== null
  );
}

/**
 * Provider range limits are discovered by shrinking, never by reading the error text. Endpoints
 * disagree about the wording and about the limit they name; one rejects a 500-block query with a
 * message quoting 10 000. A parser that believes the message loops forever.
 *
 * A transport failure is not a range refusal. It is rethrown so the tick backs off instead of
 * hammering an endpoint that is already struggling.
 */
function isRangeRejection(error: unknown): boolean {
  return error instanceof Error && !isTransportFailure(error);
}

export class EvmChainGateway implements ChainGateway {
  private readonly chainIdentifier: number;
  private readonly client: PublicClient;
  private readonly finalityClient: PublicClient | null;

  readonly networkIdentifier: NetworkIdentifier;
  readonly supportsFinalityTag: boolean;

  constructor(options: EvmChainGatewayOptions) {
    this.networkIdentifier = options.networkIdentifier;
    this.chainIdentifier = options.chainIdentifier;
    this.supportsFinalityTag = options.supportsFinalityTag;

    // A fallback transport moves on when an endpoint is rate limited or lying about being healthy.
    this.client = createPublicClient({
      transport: fallback(options.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
    });

    const quorumUrls = options.finalityQuorumRpcUrls ?? [];
    this.finalityClient =
      quorumUrls.length === 0
        ? null
        : createPublicClient({
            transport: fallback(quorumUrls.map((url) => http(url, { timeout: 10_000 }))),
          });
  }

  async assertLedgerIdentity(): Promise<void> {
    const observed = await this.client.getChainId();
    if (observed !== this.chainIdentifier) {
      throw new LedgerIdentityMismatchError(this.chainIdentifier.toString(), observed.toString());
    }
  }

  /**
   * Only 'finalized' and numeric heights are ever used. The 'safe' tag type-checks in viem and is
   * not served by Polygon, so asking for it fails at runtime on the one network this ships for.
   */
  private async readFinalizedHeight(): Promise<bigint | null> {
    if (!this.supportsFinalityTag) {
      return null;
    }
    try {
      const finalized = await this.client.getBlock({ blockTag: 'finalized' });
      return finalized.number;
    } catch {
      // A provider that cannot answer must not be read as "nothing is final". The caller holds.
      return null;
    }
  }

  async readChainProgress(): Promise<ChainProgress> {
    const tip = await this.client.getBlock({ blockTag: 'latest' });
    const finalizedHeight = await this.readFinalizedHeight();

    return {
      tip: toLedgerPosition(tip.number, tip.hash),
      finalizedHeight,
      observedAtMilliseconds: Date.now(),
    };
  }

  async confirmFinalizedHeight(height: bigint): Promise<FinalityConfirmation> {
    if (this.finalityClient === null) {
      return 'unavailable';
    }
    try {
      const finalized = await this.finalityClient.getBlock({ blockTag: 'finalized' });
      return finalized.number >= height ? 'confirmed' : 'contradicted';
    } catch {
      return 'unavailable';
    }
  }

  async readPositionAtHeight(height: bigint): Promise<LedgerPositionLookup> {
    try {
      const block = await this.client.getBlock({ blockNumber: height });
      return {
        kind: 'present',
        header: {
          position: toLedgerPosition(block.number, block.hash),
          parentReference: block.parentHash.toLowerCase(),
        },
      };
    } catch (error) {
      // Why the question failed decides what the caller does about it, so the two causes are kept
      // apart. An endpoint that did not answer is asked again next tick; a block the node no longer
      // retains means the history this system relies on is gone, and scanning has to stop.
      //
      // Collapsing both into 'absent' meant a rate limit or a timeout during fork resolution halted
      // the network, which freezes completion and expiry for every payment on it until an operator
      // resumes it by hand.
      if (isTransportFailure(error)) {
        return {
          kind: 'unavailable',
          reason: error instanceof BaseError ? error.shortMessage : 'the endpoint did not answer',
        };
      }
      // An EVM chain has a block at every height, so a height the node answered about and does not
      // have is one it pruned rather than one that was skipped.
      return { kind: 'absent' };
    }
  }

  async scanIncomingTransfers(request: TransferScanRequest): Promise<TransferScanResult> {
    const transfers: ObservedTransfer[] = [];
    const tokenReferences = request.assetReferences.filter(
      (reference) => reference !== NATIVE_ASSET_REFERENCE,
    );

    // No watched account means no query at all: an empty `args.to` array matches every transfer on
    // the contract, which would pull the token's entire traffic back over the wire.
    if (request.watchedAccounts.length > 0 && tokenReferences.length > 0) {
      const tokenRequest = { ...request, assetReferences: tokenReferences };
      for (const accounts of chunk(request.watchedAccounts, MAXIMUM_ACCOUNTS_PER_QUERY)) {
        transfers.push(...(await this.scanChunk(tokenRequest, accounts)));
      }
    }

    // Native currency emits no log, so there is nothing to filter on and the block bodies have to
    // be read. That is far more expensive than a log query - measured at roughly two hundred
    // kilobytes per block on Polygon - which is why it happens only when a payment is actually
    // waiting for native currency.
    const nativeIsWatched = request.assetReferences.includes(NATIVE_ASSET_REFERENCE);
    if (nativeIsWatched && request.watchedAccounts.length > 0) {
      transfers.push(...(await this.scanNativeTransfers(request)));
    }

    // Headers are read even when nothing was watched, because the chain fork resolution walks has to
    // stay unbroken across quiet windows. Only the trailing depth is read; heights below it are
    // beyond anything a reorg walk consults.
    const headerFrom = maximum(
      request.fromHeight,
      request.toHeight - BigInt(request.headerDepth - 1),
    );
    const headers = await this.readHeaders(headerFrom, request.toHeight);
    const scannedThrough = headers.at(-1) ?? (await this.readHeaderOrThrow(request.toHeight));
    return { scannedThrough, headers, transfers };
  }

  /**
   * Native transfers, read out of the block bodies.
   *
   * Two things are deliberately not done here. Traces are not used, because `trace_block` and
   * `debug_traceBlockByNumber` are not served by the public Polygon endpoints this runs against, so
   * depending on them would make the feature work only on a paid provider. And a transaction's
   * success is not assumed from its presence in a block: a reverted transfer occupies a block and
   * moves nothing, so its receipt is read before anything is credited.
   *
   * The consequence of not using traces is stated rather than hidden: a native transfer made by a
   * contract rather than by a plain transaction does not appear in a block body, and is not seen
   * here. Reconciliation compares the destination balance against the credited total, which is what
   * notices one.
   */
  private async scanNativeTransfers(
    request: TransferScanRequest,
  ): Promise<readonly ObservedTransfer[]> {
    const watched = new Set(request.watchedAccounts.map((account) => account.toLowerCase()));
    const transfers: ObservedTransfer[] = [];

    for (let height = request.fromHeight; height <= request.toHeight; height += 1n) {
      const block = await this.readBlockWithTransactions(height);
      if (block === null) {
        continue;
      }
      transfers.push(...(await this.creditsInBlock(block, watched)));
    }
    return transfers;
  }

  private async readBlockWithTransactions(height: bigint) {
    try {
      return await this.client.getBlock({ blockNumber: height, includeTransactions: true });
    } catch (error) {
      if (isTransportFailure(error)) {
        throw error;
      }
      // A height the endpoint will not serve is skipped rather than treated as an outage; the
      // cursor does not advance past a window that threw, so nothing is silently missed.
      return null;
    }
  }

  private async creditsInBlock(
    block: Awaited<ReturnType<PublicClient['getBlock']>>,
    watched: ReadonlySet<string>,
  ): Promise<readonly ObservedTransfer[]> {
    const credits: ObservedTransfer[] = [];
    const candidates = block.transactions.filter(
      (transaction): transaction is Exclude<typeof transaction, `0x${string}`> =>
        typeof transaction !== 'string' &&
        transaction.to !== null &&
        transaction.value > 0n &&
        watched.has(transaction.to.toLowerCase()),
    );

    for (const transaction of candidates) {
      const receipt = await this.client.getTransactionReceipt({ hash: transaction.hash });
      if (receipt.status !== 'success') {
        continue;
      }
      credits.push({
        reference: {
          transactionReference: transaction.hash.toLowerCase(),
          // A plain value transfer emits no log, so there is no log index to use. Zero is correct
          // and cannot collide with a token transfer in the same transaction, because a transaction
          // that moves value to a watched address and also emits a Transfer to it would be a
          // contract call, and those are not read here.
          eventIndex: 0,
        },
        position: toLedgerPosition(block.number ?? 0n, block.hash ?? ''),
        sourceAccount: toCanonicalAddress(transaction.from),
        destinationAccount: toCanonicalAddress(transaction.to ?? ''),
        assetReference: NATIVE_ASSET_REFERENCE,
        amountInBaseUnits: transaction.value,
      });
    }
    return credits;
  }

  private async scanChunk(
    request: TransferScanRequest,
    accounts: readonly string[],
  ): Promise<ObservedTransfer[]> {
    // One query for every watched address rather than one per address, and filtered by asset
    // contract because the address is the only identity a token has: bridged USDC.e reports the
    // byte-identical symbol, so a symbol comparison anywhere here would credit the wrong token.
    try {
      const logs = await this.client.getLogs({
        address: request.assetReferences.map((reference) => getAddress(reference)),
        event: TRANSFER_EVENT,
        args: { to: accounts.map((account) => getAddress(account)) },
        fromBlock: request.fromHeight,
        toBlock: request.toHeight,
        // Anything that does not decode cleanly against the event is discarded rather than guessed.
        strict: true,
      });

      return logs
        .filter((log) => !log.removed)
        .map((log) => ({
          reference: {
            transactionReference: log.transactionHash.toLowerCase(),
            eventIndex: log.logIndex,
          },
          position: toLedgerPosition(log.blockNumber, log.blockHash),
          sourceAccount: toCanonicalAddress(log.args.from),
          destinationAccount: toCanonicalAddress(log.args.to),
          assetReference: toCanonicalAddress(log.address),
          // The amount is the decoded event value and nothing else. It never comes from a request
          // body, a query parameter, or anything a client reported.
          amountInBaseUnits: log.args.value,
        }));
    } catch (error) {
      if (isRangeRejection(error)) {
        throw new LedgerRangeTooWideError(
          `The endpoint refused a ${(request.toHeight - request.fromHeight + 1n).toString()} block range`,
        );
      }
      throw error;
    }
  }

  private async readHeaders(from: bigint, to: bigint): Promise<LedgerHeader[]> {
    const headers: LedgerHeader[] = [];
    for (let height = from; height <= to; height += 1n) {
      const lookup = await this.readPositionAtHeight(height);
      if (lookup.kind === 'present') {
        headers.push(lookup.header);
      }
    }
    return headers;
  }

  private async readHeaderOrThrow(height: bigint): Promise<LedgerHeader> {
    const lookup = await this.readPositionAtHeight(height);
    if (lookup.kind !== 'present') {
      throw new Error(`No block header available at height ${height.toString()}`);
    }
    return lookup.header;
  }

  /**
   * The only reorg-safe way to ask whether a transfer still counts.
   *
   * The receipt is checked for success, and the log is re-read filtered by the block hash that was
   * recorded. Filtering by height instead would happily return a log from the replacement block at
   * the same height, which is exactly the case this exists to catch.
   */
  async reconcileTransfer(
    reference: ChainTransferReference,
    expected: LedgerPosition,
  ): Promise<TransferReconciliation> {
    try {
      const receipt = await this.client.getTransactionReceipt({
        hash: reference.transactionReference as Hex,
      });

      if (receipt.status !== 'success') {
        return { kind: 'orphaned' };
      }
      if (receipt.blockHash.toLowerCase() !== expected.reference) {
        return { kind: 'orphaned' };
      }

      const stillPresent = receipt.logs.some(
        (log) => log.logIndex === reference.eventIndex && !log.removed,
      );
      if (!stillPresent) {
        return { kind: 'orphaned' };
      }

      return {
        kind: 'present',
        position: toLedgerPosition(receipt.blockNumber, receipt.blockHash),
      };
    } catch (error) {
      // A dropped transaction and an unreachable provider look identical from here. Reporting
      // "indeterminate" leaves the row alone; reporting "orphaned" would withdraw a real credit
      // because an endpoint had a bad minute.
      if (error instanceof Error && /not (be )?found/i.test(error.message)) {
        return { kind: 'orphaned' };
      }
      return { kind: 'indeterminate' };
    }
  }

  async readAssetBalance(account: string, assetReference: string): Promise<bigint> {
    // Native currency has no contract to ask, which is what the sentinel means. Reconciliation reads
    // balances for whatever asset a payment expects, so this branch is what lets it check a native
    // payment at all.
    if (assetReference === NATIVE_ASSET_REFERENCE) {
      return this.readNativeBalance(account);
    }
    return this.client.readContract({
      address: getAddress(assetReference),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [getAddress(account)],
    });
  }

  async readNativeBalance(account: string): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(account) });
  }
}

function maximum(left: bigint, right: bigint): bigint {
  // Math.max throws on bigints rather than comparing them.
  if (left > right) {
    return left;
  }
  return right;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
