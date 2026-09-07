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
  type Hex,
  type PublicClient,
} from 'viem';

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
 * Provider range limits are discovered by shrinking, never by reading the error text. Endpoints
 * disagree about the wording and about the limit they name; one rejects a 500-block query with a
 * message quoting 10 000. A parser that believes the message loops forever.
 */
function isRangeRejection(error: unknown): boolean {
  return error instanceof Error;
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
      throw new LedgerIdentityMismatchError(this.chainIdentifier, observed);
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
    } catch {
      // An EVM chain has a block at every height, so a height it cannot answer for is one the node
      // has pruned rather than one that was skipped.
      return { kind: 'absent' };
    }
  }

  async scanIncomingTransfers(request: TransferScanRequest): Promise<TransferScanResult> {
    if (request.watchedAccounts.length === 0 || request.assetReferences.length === 0) {
      const scannedThrough = await this.readHeaderOrThrow(request.toHeight);
      return { scannedThrough, headers: [], transfers: [] };
    }

    const transfers: ObservedTransfer[] = [];
    for (const accounts of chunk(request.watchedAccounts, MAXIMUM_ACCOUNTS_PER_QUERY)) {
      transfers.push(...(await this.scanChunk(request, accounts)));
    }

    const headers = await this.readHeaders(request.fromHeight, request.toHeight);
    const scannedThrough = headers.at(-1) ?? (await this.readHeaderOrThrow(request.toHeight));
    return { scannedThrough, headers, transfers };
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
