import type { ChainProgress, NetworkIdentifier } from '@cryptopay/shared';

import { assessFinality, needsSecondOpinion } from '../domain/finality-policy.js';
import { applyLedgerObservation } from '../domain/ledger-observation.js';
import { expirePayment } from '../domain/payment-commands.js';
import { hasExpired, type Payment } from '../domain/payment.js';
import { settlingBlockHeight, sumCreditedAmount } from '../domain/transfer-ledger.js';
import type { EvaluationQueueRepository } from '../infrastructure/persistence/evaluation-queue.repository.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../infrastructure/persistence/payment-transfer.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';
import { buildOutboxEntry } from './callback-payload.js';
import type { ChainGateway } from './ports/chain-gateway.port.js';

/**
 * Deciding what a payment is worth, from stored rows and the chain's own progress.
 *
 * Nothing here reads the chain for amounts. The credited total is recomputed by summing the transfer
 * rows the scanner wrote, so evaluating twice produces the same answer and a replayed event cannot
 * inflate a balance. What the chain is asked for is how far it has advanced, which is the one thing
 * that genuinely changes between ticks.
 *
 * Every write is a compare-and-swap on the payment's status version. Two workers reaching the same
 * payment at the same version means exactly one of them wins, and the loser simply finds its work
 * already done rather than corrupting it.
 */

export interface EvaluationOutcome {
  readonly claimed: number;
  readonly transitioned: number;
  readonly progressed: number;
  readonly contended: number;
  /** Requests spent on the finality quorum, which should be roughly one per completed payment. */
  readonly secondOpinionsRequested: number;
}

export interface EvaluatePaymentsDependencies {
  readonly gateway: ChainGateway;
  readonly paymentRepository: PaymentRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly evaluationQueueRepository: EvaluationQueueRepository;
  readonly now: () => Date;
  readonly workerIdentity: string;
  readonly ulidFactory: UlidFactory;
  readonly checkoutBaseUrl: string;
  readonly batchSize?: number;
  readonly claimLeaseSeconds?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CLAIM_LEASE_SECONDS = 30;

export class EvaluatePaymentsUseCase {
  private readonly dependencies: EvaluatePaymentsDependencies;
  private readonly network: NetworkIdentifier;
  private readonly batchSize: number;
  private readonly claimLeaseSeconds: number;

  constructor(dependencies: EvaluatePaymentsDependencies) {
    this.dependencies = dependencies;
    this.network = dependencies.gateway.networkIdentifier;
    this.batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE;
    this.claimLeaseSeconds = dependencies.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;
  }

  async execute(): Promise<EvaluationOutcome> {
    await this.dependencies.evaluationQueueRepository.enqueueLivePayments(this.network);
    const claimed = await this.dependencies.evaluationQueueRepository.claim(
      this.dependencies.workerIdentity,
      this.batchSize,
      this.claimLeaseSeconds,
    );
    if (claimed.length === 0) {
      return {
        claimed: 0,
        transitioned: 0,
        progressed: 0,
        contended: 0,
        secondOpinionsRequested: 0,
      };
    }

    const progress = await this.dependencies.gateway.readChainProgress();
    const payments = await this.dependencies.paymentRepository.findByIdentifiers(claimed);

    let transitioned = 0;
    let progressed = 0;
    let contended = 0;
    let secondOpinionsRequested = 0;

    for (const payment of payments) {
      const evaluated = await this.evaluateOne(payment, progress);
      secondOpinionsRequested += evaluated.secondOpinionRequested ? 1 : 0;
      transitioned += evaluated.result === 'transitioned' ? 1 : 0;
      progressed += evaluated.result === 'progressed' ? 1 : 0;
      contended += evaluated.result === 'contended' ? 1 : 0;
    }

    await this.dependencies.evaluationQueueRepository.release(
      this.dependencies.workerIdentity,
      claimed,
    );

    return {
      claimed: claimed.length,
      transitioned,
      progressed,
      contended,
      secondOpinionsRequested,
    };
  }

  private async evaluateOne(
    payment: Payment,
    progress: ChainProgress,
  ): Promise<{
    readonly result: 'transitioned' | 'progressed' | 'unchanged' | 'contended';
    readonly secondOpinionRequested: boolean;
  }> {
    const transfers = await this.dependencies.paymentTransferRepository.findByPayment(
      payment.identifier,
    );

    // Recomputed from rows, never incremented. The same rows always produce the same total, so a
    // duplicated event or a retried write cannot move it.
    const observedPayment: Payment = {
      ...payment,
      creditedAmountInBaseUnits: sumCreditedAmount(transfers),
      settlingBlockHeight: settlingBlockHeight(transfers),
    };

    const secondOpinionRequested = needsSecondOpinion(observedPayment, progress);
    const secondOpinion = secondOpinionRequested
      ? await this.dependencies.gateway.confirmFinalizedHeight(
          observedPayment.settlingBlockHeight ?? 0n,
        )
      : 'unavailable';
    const finality = assessFinality(observedPayment, progress, secondOpinion);

    const now = this.dependencies.now();
    const applied = applyLedgerObservation(
      payment,
      {
        creditedAmountInBaseUnits: observedPayment.creditedAmountInBaseUnits,
        settlingBlockHeight: observedPayment.settlingBlockHeight,
        confirmations: finality.confirmations,
        finalityIsOpen: finality.creditable,
      },
      now,
    );

    if (applied.kind === 'transitioned') {
      const saved = await this.dependencies.paymentRepository.saveTransition({
        payment: applied.payment,
        previousStatus: payment.status,
        expectedVersion: payment.statusVersion,
        command: 'applyLedgerObservation',
        causedBy: applied.trigger,
        // Written inside the same transaction as the status change. A completed payment that nobody
        // was told about is therefore not a state this database can hold.
        outbox: this.outboxFor(applied.payment, now),
      });
      return { result: saved ? 'transitioned' : 'contended', secondOpinionRequested };
    }

    if (applied.kind === 'progressed') {
      const saved = await this.dependencies.paymentRepository.saveProgress(
        applied.payment,
        payment.statusVersion,
      );
      if (!saved) {
        return { result: 'contended', secondOpinionRequested };
      }
      // Expiry is evaluated against the figures just written, so a payment that both received
      // partial funds and ran out of time resolves in one pass rather than waiting a whole tick.
      const expiryResult = await this.expireIfElapsed(applied.payment, now);
      if (expiryResult === 'unchanged') {
        return { result: 'progressed', secondOpinionRequested };
      }
      return { result: expiryResult, secondOpinionRequested };
    }

    const expiryResult = await this.expireIfElapsed(observedPayment, now);
    return { result: expiryResult, secondOpinionRequested };
  }

  /**
   * Expiry runs after the ledger observation, never before it.
   *
   * A transfer that lands in the same second as the deadline must win: the customer's money has
   * already left their wallet, and expiring the payment anyway would be taking it. Because the
   * observation is applied first, a payment that reached the acceptance band is already `confirming`
   * by the time the clock is consulted, and the domain refuses to expire that.
   */
  private async expireIfElapsed(
    payment: Payment,
    now: Date,
  ): Promise<'transitioned' | 'unchanged' | 'contended'> {
    if (!hasExpired(payment, now)) {
      return 'unchanged';
    }
    const decision = expirePayment(payment, now);
    if (decision.kind !== 'applied') {
      return 'unchanged';
    }
    const saved = await this.dependencies.paymentRepository.saveTransition({
      payment: decision.payment,
      previousStatus: payment.status,
      expectedVersion: payment.statusVersion,
      command: decision.command,
      causedBy: decision.trigger,
      outbox: this.outboxFor(decision.payment, now),
    });
    return saved ? 'transitioned' : 'contended';
  }

  private outboxFor(payment: Payment, now: Date) {
    return buildOutboxEntry({
      payment,
      eventType: `payment.${payment.status}`,
      occurredAt: now,
      checkoutBaseUrl: this.dependencies.checkoutBaseUrl,
      ulidFactory: this.dependencies.ulidFactory,
    });
  }
}
