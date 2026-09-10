import type {
  ChainProgress,
  ChainTransferReference,
  LedgerHeader,
  LedgerPosition,
  NetworkIdentifier,
  ObservedTransfer,
} from '@cryptopay/shared';
import { NATIVE_ASSET_REFERENCE } from '@cryptopay/shared';

import {
  LedgerIdentityMismatchError,
  LedgerRangeTooWideError,
  type ChainGateway,
  type FinalityConfirmation,
  type LedgerPositionLookup,
  type TransferReconciliation,
  type TransferScanRequest,
  type TransferScanResult,
} from '../../../application/ports/chain-gateway.port.js';
import type {
  SolanaBlock,
  SolanaNativeDelta,
  SolanaNode,
  SolanaTokenDelta,
} from './solana-client.js';

/**
 * Solana as a read oracle, in the same ledger vocabulary the payment engine speaks.
 *
 * Four things about this chain are genuinely different from the other two, and each is handled here
 * rather than smoothed over.
 *
 * Slots are skipped. A leader that fails to produce leaves an empty slot, so a block's parent is
 * routinely not the slot before it. Following height minus one would read an ordinary healthy chain
 * as a fork and halt the network, which is why the port has a `skipped` arm at all and why the
 * header chain links by identifier rather than by arithmetic.
 *
 * There is no confirmation count. Solana states a commitment, and everything here reads at
 * `finalized`. A block that is finalized does not move again, so the scan never observes a transfer
 * that later stops existing. The cost is about twelve seconds of latency, which for a payment is
 * nothing, and the benefit is that the reorg machinery is defensive on this chain rather than
 * load-bearing.
 *
 * An SPL transfer credits a token account, not the wallet. The node resolves the owner of that
 * account and reports it, so the adapter matches on the owner and never derives an associated token
 * account. Deriving one would mean reimplementing a program-derived address and hoping the result
 * matches what the token program actually used.
 *
 * A payment is a balance delta rather than an event. Solana emits no transfer log, so a credit is
 * the difference between an account's balance before and after a transaction.
 */

/**
 * Each slot in the window costs one request for its block, so the window is small. Solana produces
 * a slot roughly every four hundred milliseconds, so four hundred slots is about three minutes of
 * catch-up per tick.
 */
const MAXIMUM_SCAN_SLOTS = 400;

export interface SolanaChainGatewayOptions {
  readonly networkIdentifier: NetworkIdentifier;
  readonly node: SolanaNode;
  /** The genesis hash this network must report. */
  readonly expectedLedgerIdentity: string;
}

interface Credit {
  readonly account: string;
  readonly asset: string;
  readonly amount: bigint;
}

/** A native credit is an account whose lamport balance rose. One that fell is the payer. */
function nativeCredits(
  deltas: readonly SolanaNativeDelta[],
  watchedAccounts: ReadonlySet<string>,
): readonly Credit[] {
  return deltas
    .filter((delta) => delta.after > delta.before && watchedAccounts.has(delta.account))
    .map((delta) => ({
      account: delta.account,
      asset: NATIVE_ASSET_REFERENCE,
      amount: delta.after - delta.before,
    }));
}

/**
 * Matched on the owner the node resolved, never on a token account address derived here. An SPL
 * transfer credits a token account rather than the wallet, and the node already knows which wallet
 * owns it.
 */
function tokenCredits(
  deltas: readonly SolanaTokenDelta[],
  watchedAccounts: ReadonlySet<string>,
  watchedMints: ReadonlySet<string>,
): readonly Credit[] {
  return deltas
    .filter(
      (delta) =>
        delta.after > delta.before &&
        watchedMints.has(delta.mint) &&
        watchedAccounts.has(delta.owner),
    )
    .map((delta) => ({
      account: delta.owner,
      asset: delta.mint,
      amount: delta.after - delta.before,
    }));
}

function toPosition(block: SolanaBlock): LedgerPosition {
  return { height: BigInt(block.header.slot), reference: block.header.blockhash };
}

function toLedgerHeader(block: SolanaBlock): LedgerHeader {
  return { position: toPosition(block), parentReference: block.header.previousBlockhash };
}

export class SolanaChainGateway implements ChainGateway {
  private readonly node: SolanaNode;
  private readonly expectedLedgerIdentity: string;

  readonly networkIdentifier: NetworkIdentifier;
  /**
   * Scanning reads finalized blocks only, so every height the engine is told about is already
   * final. The finality gate is satisfied by the commitment rather than by a separate tag.
   */
  readonly supportsFinalityTag = true;

  constructor(options: SolanaChainGatewayOptions) {
    this.networkIdentifier = options.networkIdentifier;
    this.node = options.node;
    this.expectedLedgerIdentity = options.expectedLedgerIdentity;
  }

  async assertLedgerIdentity(): Promise<void> {
    const observed = await this.node.readGenesisIdentity();
    if (observed !== this.expectedLedgerIdentity) {
      throw new LedgerIdentityMismatchError(this.expectedLedgerIdentity, observed);
    }
  }

  /**
   * The tip and the finalized height are the same slot, because nothing below finality is read. A
   * tip taken at a looser commitment would be a number the scanner is not allowed to act on.
   */
  async readChainProgress(): Promise<ChainProgress> {
    const slot = await this.node.readFinalizedSlot();
    const finalized = BigInt(slot);
    return {
      tip: { height: finalized, reference: '' },
      finalizedHeight: finalized,
      observedAtMilliseconds: 0,
    };
  }

  async confirmFinalizedHeight(height: bigint): Promise<FinalityConfirmation> {
    try {
      const slot = await this.node.readFinalizedSlot();
      return BigInt(slot) >= height ? 'confirmed' : 'contradicted';
    } catch {
      return 'unavailable';
    }
  }

  async readPositionAtHeight(height: bigint): Promise<LedgerPositionLookup> {
    try {
      const block = await this.node.readBlock(Number(height));
      if (block === null) {
        // The slot exists and produced nothing. Distinct from an outage and from a pruned height:
        // treating it as either would halt a network that is behaving normally.
        return { kind: 'skipped' };
      }
      return { kind: 'present', header: toLedgerHeader(block) };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: error instanceof Error ? error.message : 'the endpoint did not answer',
      };
    }
  }

  async scanIncomingTransfers(request: TransferScanRequest): Promise<TransferScanResult> {
    const fromSlot = Number(request.fromHeight);
    const toSlot = Number(request.toHeight);
    if (toSlot - fromSlot + 1 > MAXIMUM_SCAN_SLOTS) {
      throw new LedgerRangeTooWideError(
        `Solana is read block by block, so a scan covers at most ${MAXIMUM_SCAN_SLOTS} slots`,
      );
    }

    const watchedAccounts = new Set(request.watchedAccounts);
    const watchedMints = new Set(
      request.assetReferences.filter((reference) => reference !== NATIVE_ASSET_REFERENCE),
    );
    const nativeIsWatched = request.assetReferences.includes(NATIVE_ASSET_REFERENCE);

    // Asking which slots produced a block is one request, and it is what keeps the adapter from
    // treating the many skipped slots in any range as missing data.
    const produced = await this.node.readProducedSlots(fromSlot, toSlot);
    const blocks: SolanaBlock[] = [];
    for (const slot of produced) {
      const block = await this.node.readBlock(slot);
      if (block !== null) {
        blocks.push(block);
      }
    }

    const transfers: ObservedTransfer[] = [];
    for (const block of blocks) {
      transfers.push(...this.readTransfers(block, watchedAccounts, watchedMints, nativeIsWatched));
    }

    const last = blocks.at(-1);
    if (last === undefined) {
      // Every slot in the window was skipped, which is ordinary. The window still advanced, so the
      // caller is told where it reached with a header carrying no block of its own.
      return {
        scannedThrough: {
          position: { height: BigInt(toSlot), reference: '' },
          parentReference: '',
        },
        headers: [],
        transfers: [],
      };
    }

    const headers = blocks
      .slice(Math.max(0, blocks.length - request.headerDepth))
      .map((block) => toLedgerHeader(block));
    return { scannedThrough: toLedgerHeader(last), headers, transfers };
  }

  private readTransfers(
    block: SolanaBlock,
    watchedAccounts: ReadonlySet<string>,
    watchedMints: ReadonlySet<string>,
    nativeIsWatched: boolean,
  ): readonly ObservedTransfer[] {
    const transfers: ObservedTransfer[] = [];
    const succeeded = block.transactions.filter((transaction) => transaction.succeeded);

    for (const transaction of succeeded) {
      const credits = [
        ...(nativeIsWatched ? nativeCredits(transaction.nativeDeltas, watchedAccounts) : []),
        ...tokenCredits(transaction.tokenDeltas, watchedAccounts, watchedMints),
      ];

      for (const [eventIndex, credit] of credits.entries()) {
        transfers.push({
          // The index is per transaction and stable within it, so two credits in one transaction
          // stay distinct under the uniqueness key that makes crediting happen exactly once.
          reference: { transactionReference: transaction.signature, eventIndex },
          position: toPosition(block),
          destinationAccount: credit.account,
          // Solana has no single sender: one transaction may debit several accounts. Naming one
          // would be a guess, and the guess this used to make was the credited account, which put
          // the merchant's own deposit address under a heading that reads "From".
          sourceAccount: null,
          assetReference: credit.asset,
          amountInBaseUnits: credit.amount,
        });
      }
    }

    return transfers;
  }

  async reconcileTransfer(
    reference: ChainTransferReference,
    expected: LedgerPosition,
  ): Promise<TransferReconciliation> {
    try {
      const slot = await this.node.readSlotOfSignature(reference.transactionReference);
      if (slot === null) {
        // Before withdrawing a credit, confirm this node can still serve the slot the transfer was
        // recorded in. A validator that is behind, or one whose history does not reach back that
        // far, answers "unknown" exactly as one does for a signature that genuinely no longer
        // exists, and only one of those two justifies taking a merchant's money back.
        const recorded = await this.node.readBlock(Number(expected.height));
        if (recorded === null) {
          return { kind: 'indeterminate' };
        }
        return { kind: 'orphaned' };
      }
      const block = await this.node.readBlock(slot);
      if (block === null) {
        return { kind: 'indeterminate' };
      }
      return { kind: 'present', position: toPosition(block) };
    } catch {
      return { kind: 'indeterminate' };
    }
  }

  async readAssetBalance(account: string, assetReference: string): Promise<bigint> {
    if (assetReference === NATIVE_ASSET_REFERENCE) {
      return this.node.readNativeBalance(account);
    }
    return this.node.readTokenBalance(account, assetReference);
  }

  async readNativeBalance(account: string): Promise<bigint> {
    return this.node.readNativeBalance(account);
  }
}
