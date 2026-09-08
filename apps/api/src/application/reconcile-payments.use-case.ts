import type { NetworkIdentifier } from '@cryptopay/shared';

import type { ChainGateway } from './ports/chain-gateway.port.js';
import type { EvaluationQueueRepository } from '../infrastructure/persistence/evaluation-queue.repository.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';
import type {
  PaymentTransferRepository,
  ReconcilableTransfer,
} from '../infrastructure/persistence/payment-transfer.repository.js';

/**
 * The check that runs when nothing went wrong, so that something going wrong is still noticed.
 *
 * Scanning is the primary path and it is careful: the cursor only advances inside the transaction
 * that writes what it covers, so a crash replays a window rather than skipping it. But every
 * argument for why it cannot miss a payment is an argument about code that is already running. If
 * an endpoint returned a truncated log page, if a window was scanned while a provider was serving a
 * minority fork, or if a transfer was recorded and later removed by a reorganisation nobody looked
 * at again, the database and the chain disagree and nothing in the scanning path will ever notice.
 *
 * Two questions are asked here, and they are deliberately different in kind.
 *
 * The first re-asks the chain about transfers this system already recorded. A transfer that is no
 * longer on the canonical chain is orphaned, which withdraws value the payment was credited with.
 * That path exists on every adapter and had no caller until now.
 *
 * The second is an independent oracle rather than a second opinion. It reads the destination's
 * balance and compares it with what this system believes it credited. A balance read goes through a
 * different code path, a different request and a different index than a log scan, so it can see a
 * payment the scan missed. Re-running the scan would only ask the same question that already
 * returned the wrong answer.
 *
 * What it deliberately does not do is repair anything itself. A discrepancy enqueues the payment for
 * the ordinary evaluation path, which is the tested code that decides what a credit means. A
 * reconciliation worker that wrote statuses directly would be a second, less-tested way to move
 * money, and its database role has no permission to do so.
 */

export interface ReconcileOutcome {
  readonly checkedTransfers: number;
  readonly orphanedTransfers: number;
  readonly checkedAccounts: number;
  /** Destinations holding more than this system has credited them with. */
  readonly discrepancies: number;
  readonly requeued: number;
}

export interface ReconcilePaymentsDependencies {
  readonly gateway: ChainGateway;
  readonly paymentRepository: PaymentRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly evaluationQueueRepository: EvaluationQueueRepository;
  readonly now: () => Date;
}

/**
 * How many destinations one tick reads a balance for. Bounded because each is a request, and a
 * reconciliation pass that outpaced the scanner's rate limit would cause the outage it exists to
 * detect.
 */
const ACCOUNTS_PER_TICK = 25;

/** How many recorded transfers one tick re-checks against the chain. */
const TRANSFERS_PER_TICK = 50;

export class ReconcilePaymentsUseCase {
  private readonly dependencies: ReconcilePaymentsDependencies;
  private readonly network: NetworkIdentifier;

  constructor(dependencies: ReconcilePaymentsDependencies) {
    this.dependencies = dependencies;
    this.network = dependencies.gateway.networkIdentifier;
  }

  async execute(): Promise<ReconcileOutcome> {
    const orphaned = await this.reCheckRecordedTransfers();
    const balances = await this.compareBalances();
    return { ...orphaned, ...balances };
  }

  /**
   * Asks the chain whether transfers this system recorded are still there.
   *
   * Only transfers below the finalized height are worth asking about: above it a disagreement is
   * ordinary and the scanner is still working through it. An endpoint that cannot answer leaves the
   * row exactly as it is, because "I do not know" must never be recorded as "it is gone".
   */
  private async reCheckRecordedTransfers(): Promise<
    Pick<ReconcileOutcome, 'checkedTransfers' | 'orphanedTransfers'>
  > {
    const progress = await this.dependencies.gateway.readChainProgress();
    const finalized = progress.finalizedHeight;
    if (finalized === null) {
      return { checkedTransfers: 0, orphanedTransfers: 0 };
    }

    const candidates = await this.dependencies.paymentTransferRepository.findReconcilable(
      this.network,
      finalized,
      TRANSFERS_PER_TICK,
    );

    let orphanedTransfers = 0;
    for (const transfer of candidates) {
      const orphanedNow = await this.reCheckOne(transfer);
      orphanedTransfers += orphanedNow ? 1 : 0;
    }

    // Marked after the pass, so the next tick reaches rows this one did not.
    await this.dependencies.paymentTransferRepository.markReconciled(
      candidates.map((transfer) => transfer.identifier),
      this.dependencies.now(),
    );
    return { checkedTransfers: candidates.length, orphanedTransfers };
  }

  private async reCheckOne(transfer: ReconcilableTransfer): Promise<boolean> {
    const verdict = await this.dependencies.gateway.reconcileTransfer(
      { transactionReference: transfer.transactionReference, eventIndex: transfer.eventIndex },
      { height: transfer.blockHeight, reference: transfer.blockReference },
    );

    if (verdict.kind === 'indeterminate') {
      return false;
    }
    if (verdict.kind === 'present' && verdict.position.reference === transfer.blockReference) {
      return false;
    }

    // Either the chain no longer knows this transfer, or it now sits in a block with a different
    // identifier. Both mean the value it carried is no longer on the canonical chain.
    const orphaned = await this.dependencies.paymentTransferRepository.markOrphaned(
      transfer.identifier,
      this.dependencies.now(),
    );
    if (orphaned) {
      await this.dependencies.evaluationQueueRepository.enqueue(transfer.paymentId);
    }
    return orphaned;
  }

  /**
   * Compares what each live destination holds with what this system credited it.
   *
   * A balance greater than the credited total means money arrived that was never seen. The payment
   * is enqueued and the ordinary evaluation path decides what it means; nothing is credited here.
   *
   * The reverse case, a balance below the credited total, is not treated as a discrepancy. It is the
   * normal state of a swept destination and of any destination a merchant controls and spends from.
   */
  private async compareBalances(): Promise<
    Pick<ReconcileOutcome, 'checkedAccounts' | 'discrepancies' | 'requeued'>
  > {
    const watched = await this.dependencies.paymentRepository.findReconcilableDestinations(
      this.network,
      ACCOUNTS_PER_TICK,
    );

    let discrepancies = 0;
    let requeued = 0;
    for (const destination of watched) {
      const onChain = await this.readBalance(destination.account, destination.assetReference);
      if (onChain === null || onChain <= destination.creditedAmountInBaseUnits) {
        continue;
      }
      discrepancies += 1;
      const enqueued = await this.dependencies.evaluationQueueRepository.enqueue(
        destination.paymentId,
      );
      requeued += enqueued ? 1 : 0;
    }

    await this.dependencies.paymentRepository.markDestinationsReconciled(
      watched.map((destination) => destination.paymentId),
      this.dependencies.now(),
    );
    return { checkedAccounts: watched.length, discrepancies, requeued };
  }

  /** A balance that cannot be read is not evidence of anything, so it is skipped rather than acted on. */
  private async readBalance(account: string, assetReference: string): Promise<bigint | null> {
    try {
      return await this.dependencies.gateway.readAssetBalance(account, assetReference);
    } catch {
      return null;
    }
  }
}
