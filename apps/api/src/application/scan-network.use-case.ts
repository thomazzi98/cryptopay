import type { LedgerHeader, NetworkIdentifier } from '@cryptopay/shared';

import { classifyTransfer } from '../domain/transfer-ledger.js';
import { networkConfigurationFor } from '../infrastructure/chain/network-configuration.js';
import type { BlockCursor } from '../infrastructure/persistence/block-cursor.repository.js';
import type { BlockCursorRepository } from '../infrastructure/persistence/block-cursor.repository.js';
import type {
  ChainScanStore,
  RecordableTransfer,
} from '../infrastructure/persistence/chain-scan.store.js';
import type { ObservedBlockRepository } from '../infrastructure/persistence/observed-block.repository.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../infrastructure/persistence/payment-transfer.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';
import {
  LedgerRangeTooWideError,
  type ChainGateway,
  type TransferScanResult,
} from './ports/chain-gateway.port.js';

/**
 * One tick of the block scanner.
 *
 * The order of operations is the whole design. Ancestry is checked before anything new is read, so a
 * fork is corrected before it can be built on. The window is bounded and shrinks on refusal. The
 * transfers, the headers, the evaluation queue and the cursor advance are committed together, so a
 * crash replays the identical window and the uniqueness constraints make the replay a no-op.
 *
 * Nothing here decides what a payment is worth. It records what the chain showed and queues the
 * payment for evaluation; crediting is a separate step against stored rows.
 */

export interface ScanPolicy {
  /** How long a terminal payment stays watched, so a late transfer is still recorded. */
  readonly terminalGraceSeconds: number;
  readonly minimumScanRange: number;
  readonly maximumScanRange: number;
  /** Consecutive clean windows before the range is allowed to grow again. */
  readonly successesBeforeGrowth: number;
}

const DEFAULT_SCAN_POLICY: ScanPolicy = Object.freeze({
  terminalGraceSeconds: 86_400,
  minimumScanRange: 1,
  maximumScanRange: 500,
  successesBeforeGrowth: 5,
});

export type ScanOutcome =
  | {
      readonly kind: 'scanned';
      readonly fromHeight: bigint;
      readonly toHeight: bigint;
      readonly transfersObserved: number;
      readonly paymentsAffected: number;
    }
  /** Caught up: the cursor is at the tip and there is nothing new to read. */
  | { readonly kind: 'idle'; readonly tipHeight: bigint }
  | {
      readonly kind: 'rewound';
      readonly forkHeight: bigint;
      readonly orphanedTransfers: number;
      readonly paymentsAffected: number;
    }
  | { readonly kind: 'halted'; readonly reason: string }
  /**
   * The window read back inconsistently and was discarded rather than committed. Not an error and
   * not a halt: the same range is read again next tick, against a chain that has settled.
   */
  | { readonly kind: 'discarded'; readonly reason: string }
  /** Another worker holds the lease. Every write this tick attempted affected zero rows. */
  | { readonly kind: 'lease_lost' };

type ForkResolution =
  | { readonly kind: 'consistent' }
  | { readonly kind: 'forked'; readonly header: { height: bigint; reference: string } }
  /** Nobody could answer. Change nothing, ask again next tick. */
  | { readonly kind: 'undecided'; readonly reason: string }
  | { readonly kind: 'unresolvable'; readonly reason: string };

export interface ScanNetworkDependencies {
  readonly gateway: ChainGateway;
  readonly paymentRepository: PaymentRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly blockCursorRepository: BlockCursorRepository;
  readonly observedBlockRepository: ObservedBlockRepository;
  readonly chainScanStore: ChainScanStore;
  readonly ulidFactory: UlidFactory;
  readonly now: () => Date;
  readonly policy?: ScanPolicy;
}

export class ScanNetworkUseCase {
  private readonly dependencies: ScanNetworkDependencies;
  private readonly policy: ScanPolicy;
  private readonly network: NetworkIdentifier;

  constructor(dependencies: ScanNetworkDependencies) {
    this.dependencies = dependencies;
    this.policy = dependencies.policy ?? DEFAULT_SCAN_POLICY;
    this.network = dependencies.gateway.networkIdentifier;
  }

  async execute(fencingToken: bigint): Promise<ScanOutcome> {
    const cursor = await this.dependencies.blockCursorRepository.find(this.network);
    if (cursor === null) {
      return { kind: 'halted', reason: `no block cursor exists for ${this.network}` };
    }
    if (cursor.haltedAt !== null) {
      return { kind: 'halted', reason: cursor.haltedReason ?? 'halted' };
    }
    // A token below what the cursor already carries means this worker hung long enough for another
    // to take the lease. Stopping here is belt to the fencing braces on every write below.
    if (cursor.fencingToken > fencingToken) {
      return { kind: 'lease_lost' };
    }

    const progress = await this.dependencies.gateway.readChainProgress();

    const fork = await this.resolveFork(cursor, progress.tip.height);
    // Undecided is not a halt. Halting requires evidence that the history is unreachable, and an
    // endpoint that did not answer is evidence of nothing.
    if (fork.kind === 'undecided') {
      return { kind: 'discarded', reason: `fork resolution could not complete: ${fork.reason}` };
    }
    if (fork.kind === 'unresolvable') {
      await this.dependencies.blockCursorRepository.halt(this.network, fork.reason, fencingToken);
      return { kind: 'halted', reason: fork.reason };
    }
    if (fork.kind === 'forked') {
      const rewind = await this.dependencies.chainScanStore.commitForkRewind({
        networkIdentifier: this.network,
        forkHeight: fork.header.height,
        forkReference: fork.header.reference,
        fencingToken,
      });
      if (!rewind.applied) {
        return { kind: 'lease_lost' };
      }
      return {
        kind: 'rewound',
        forkHeight: fork.header.height,
        orphanedTransfers: rewind.orphanedTransfers,
        paymentsAffected: rewind.affectedPayments.length,
      };
    }

    const fromHeight = cursor.lastScannedHeight + 1n;
    if (fromHeight > progress.tip.height) {
      await this.dependencies.blockCursorRepository.recordFinality(
        this.network,
        progress.finalizedHeight,
        fencingToken,
      );
      await this.markFinalized(progress.finalizedHeight);
      return { kind: 'idle', tipHeight: progress.tip.height };
    }

    const watchedAccounts = await this.dependencies.paymentRepository.findWatchedAccounts(
      this.network,
      this.policy.terminalGraceSeconds,
    );

    const attempt = await this.scanAdaptively(
      cursor,
      fromHeight,
      progress.tip.height,
      watchedAccounts,
    );
    const incoherent = this.findIncoherentTransfer(attempt.result);
    if (incoherent !== null) {
      return { kind: 'discarded', reason: incoherent };
    }

    const transfers = await this.classifyObservedTransfers(attempt.result);

    const committed = await this.dependencies.chainScanStore.commitScannedWindow({
      networkIdentifier: this.network,
      transfers,
      headers: attempt.result.headers,
      scannedThrough: attempt.result.scannedThrough,
      finalizedHeight: progress.finalizedHeight,
      nextScanRange: attempt.nextScanRange,
      consecutiveSuccesses: attempt.shrank ? 0 : cursor.consecutiveSuccesses + 1,
      fencingToken,
    });
    if (!committed) {
      return { kind: 'lease_lost' };
    }

    await this.markFinalized(progress.finalizedHeight);
    await this.pruneHeaderRing(attempt.result.scannedThrough);

    return {
      kind: 'scanned',
      fromHeight,
      toHeight: attempt.result.scannedThrough.position.height,
      transfersObserved: transfers.length,
      paymentsAffected: new Set(transfers.map((record) => record.paymentId)).size,
    };
  }

  /**
   * Walks the stored header chain against the live chain until the two agree.
   *
   * The common case costs one lookup: the tip of the stored ring still matches, and nothing else is
   * read. Only a genuine divergence walks further, and it walks over headers rather than payments,
   * because a fork in a window that contained no transfers is the ordinary case and is invisible to
   * a walk over payment rows.
   */
  private async resolveFork(cursor: BlockCursor, tipHeight: bigint): Promise<ForkResolution> {
    const limit = networkConfigurationFor(this.network).maximumReorgDepth;
    const stored = await this.dependencies.observedBlockRepository.findDescendingFrom(
      this.network,
      cursor.lastScannedHeight,
      limit + 1,
    );
    // Nothing observed yet: the cursor was placed at a height this process never read. There is no
    // history to contradict, so there is no fork to resolve.
    if (stored.length === 0) {
      return { kind: 'consistent' };
    }

    let divergenceSeen = false;
    for (const header of stored) {
      // A chain shorter than the history stored for it has dropped those blocks. Asking the endpoint
      // about a height above its own tip would come back as unanswerable and read as a pruned node,
      // which would halt the network for what is an ordinary reorg.
      if (header.height > tipHeight) {
        divergenceSeen = true;
        continue;
      }

      const lookup = await this.dependencies.gateway.readPositionAtHeight(header.height);
      // Nobody answered. That is not evidence of anything about the chain, so the tick ends without
      // deciding: halting here would stop every payment on the network over a rate limit.
      if (lookup.kind === 'unavailable') {
        return { kind: 'undecided', reason: lookup.reason };
      }
      if (lookup.kind === 'absent') {
        return {
          kind: 'unresolvable',
          reason: `the endpoint no longer retains block ${header.height.toString()}`,
        };
      }
      const matches =
        lookup.kind === 'present' && lookup.header.position.reference === header.reference;
      if (matches && !divergenceSeen) {
        return { kind: 'consistent' };
      }
      if (matches) {
        return { kind: 'forked', header: { height: header.height, reference: header.reference } };
      }
      divergenceSeen = true;
    }

    // Every header on record diverges. If a full depth of them was walked, the fork is further back
    // than this system is willing to reason about and the answer is to stop.
    if (stored.length > limit) {
      return {
        kind: 'unresolvable',
        reason: `the chain diverged by more than ${limit.toString()} blocks`,
      };
    }

    // Fewer headers than the limit were on record, so the fork is at or below the oldest block this
    // network was ever seen at. Rewinding to just below it rescans more than strictly necessary,
    // which costs a few requests and cannot credit anything twice.
    const oldest = stored.at(-1);
    if (oldest === undefined || oldest.height === 0n) {
      return { kind: 'unresolvable', reason: 'the fork is below the first block on record' };
    }
    const anchorHeight = oldest.height - 1n;
    const anchor = await this.dependencies.gateway.readPositionAtHeight(anchorHeight);
    if (anchor.kind === 'unavailable') {
      return { kind: 'undecided', reason: anchor.reason };
    }
    if (anchor.kind !== 'present') {
      return {
        kind: 'unresolvable',
        reason: `the endpoint could not answer for block ${anchorHeight.toString()}`,
      };
    }
    return {
      kind: 'forked',
      header: { height: anchorHeight, reference: anchor.header.position.reference },
    };
  }

  /**
   * Shrinks the window until the endpoint accepts it, never reading the endpoint's error text.
   *
   * Providers phrase their range limits differently, change the wording between releases, and some
   * return the same message for unrelated failures. Matching on the declared error type and halving
   * is the only version of this that does not break silently on a provider update.
   */
  private async scanAdaptively(
    cursor: BlockCursor,
    fromHeight: bigint,
    tipHeight: bigint,
    watchedAccounts: readonly string[],
  ): Promise<{ result: TransferScanResult; nextScanRange: number; shrank: boolean }> {
    const configuration = networkConfigurationFor(this.network);
    const assetReferences = configuration.assetAllowlist.map((asset) => asset.reference);
    let range = clamp(
      cursor.currentScanRange,
      this.policy.minimumScanRange,
      this.policy.maximumScanRange,
    );
    let shrank = false;

    for (;;) {
      const toHeight = lowerOf(fromHeight + BigInt(range) - 1n, tipHeight);
      try {
        const result = await this.dependencies.gateway.scanIncomingTransfers({
          fromHeight,
          toHeight,
          watchedAccounts,
          assetReferences,
          headerDepth: configuration.maximumReorgDepth + 1,
        });
        return { result, nextScanRange: this.grownRange(cursor, range, shrank), shrank };
      } catch (error) {
        if (!(error instanceof LedgerRangeTooWideError) || range <= this.policy.minimumScanRange) {
          throw error;
        }
        range = Math.max(this.policy.minimumScanRange, Math.floor(range / 2));
        shrank = true;
      }
    }
  }

  private grownRange(cursor: BlockCursor, range: number, shrank: boolean): number {
    if (shrank) {
      return range;
    }
    if (cursor.consecutiveSuccesses + 1 < this.policy.successesBeforeGrowth) {
      return range;
    }
    return Math.min(this.policy.maximumScanRange, range * 2);
  }

  /**
   * Checks that every transfer in the window came from the block the window's own headers describe.
   *
   * Logs and headers are read in separate requests, seconds apart on a slow endpoint. A reorg
   * between them produces a result that looks perfectly consistent and is not: the transfer carries
   * the reference of a block that no longer exists, while the header recorded for that height is its
   * replacement. Fork resolution walks headers alone, so it compares the replacement against the
   * chain, finds them equal, and never rewinds. The credited transfer then stays credited forever —
   * either double counted when the transaction is re-mined at a different position, or counted once
   * for money that never arrived.
   *
   * A transfer below the header range needs no check. `headerDepth` is the configured reorg depth
   * plus one, so anything the window carries no header for is deeper than a reorg is allowed to
   * reach, and its block reference cannot change.
   *
   * Disagreement is answered by not committing. The identical range is read again on the next tick,
   * against a chain that has settled, and the second read agrees with itself.
   */
  private findIncoherentTransfer(result: TransferScanResult): string | null {
    if (result.transfers.length === 0) {
      return null;
    }

    const referenceByHeight = new Map(
      result.headers.map((header) => [header.position.height, header.position.reference]),
    );
    const lowestHeader = result.headers.at(0)?.position.height ?? null;

    for (const transfer of result.transfers) {
      const expected = referenceByHeight.get(transfer.position.height);
      if (expected === undefined) {
        if (lowestHeader !== null && transfer.position.height < lowestHeader) {
          continue;
        }
        return `no header covers height ${transfer.position.height.toString()}, which carries transfer ${transfer.reference.transactionReference}`;
      }
      if (expected !== transfer.position.reference) {
        return `transfer ${transfer.reference.transactionReference} reports block ${transfer.position.reference} at height ${transfer.position.height.toString()}, where the header says ${expected}`;
      }
    }

    return null;
  }

  private async classifyObservedTransfers(
    result: TransferScanResult,
  ): Promise<readonly RecordableTransfer[]> {
    if (result.transfers.length === 0) {
      return [];
    }
    const observedAt = this.dependencies.now().getTime();

    const accounts = [...new Set(result.transfers.map((transfer) => transfer.destinationAccount))];
    const payments = await this.dependencies.paymentRepository.findByReceivingAccounts(
      this.network,
      accounts,
    );
    const byAccount = new Map(payments.map((payment) => [payment.receivingAccount, payment]));
    const allowedAssetReferences = networkConfigurationFor(this.network).assetAllowlist.map(
      (asset) => asset.reference,
    );

    const recordable: RecordableTransfer[] = [];
    for (const transfer of result.transfers) {
      const payment = byAccount.get(transfer.destinationAccount);
      // An address the filter matched but no payment claims. The address constraint makes this
      // unreachable in practice; dropping it is still safer than attaching money to a guess.
      if (payment === undefined) {
        continue;
      }
      const classified = classifyTransfer(payment, transfer, allowedAssetReferences);
      recordable.push({
        identifier: `trf_${this.dependencies.ulidFactory.create(observedAt)}`,
        paymentId: payment.identifier,
        transfer,
        classification: classified.classification,
      });
    }
    return recordable;
  }

  private async markFinalized(finalizedHeight: bigint | null): Promise<void> {
    if (finalizedHeight === null) {
      return;
    }
    await this.dependencies.paymentTransferRepository.markFinalizedUpTo(
      this.network,
      finalizedHeight,
    );
  }

  private async pruneHeaderRing(scannedThrough: LedgerHeader): Promise<void> {
    // Twice the reorg limit, so the walk always has the full depth available even immediately after
    // a prune.
    const retained = BigInt(networkConfigurationFor(this.network).maximumReorgDepth * 2);
    if (scannedThrough.position.height <= retained) {
      return;
    }
    await this.dependencies.observedBlockRepository.pruneBelow(
      this.network,
      scannedThrough.position.height - retained,
    );
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function lowerOf(left: bigint, right: bigint): bigint {
  // Math.min throws on bigints rather than comparing them.
  if (left < right) {
    return left;
  }
  return right;
}
