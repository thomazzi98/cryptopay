import type { Environment } from '@cryptopay/shared';

import { cancelPayment } from '../domain/payment-commands.js';
import type { Payment } from '../domain/payment.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';
import type { PaymentTransferRepository } from '../infrastructure/persistence/payment-transfer.repository.js';
import type { UlidFactory } from '../infrastructure/system/ulid.js';
import { buildOutboxEntry } from './callback-payload.js';

/**
 * Cancelling a payment. Legal only while nothing has been credited: cancelling a payment a customer
 * has already funded would strand their money.
 *
 * The callback is enqueued in the same transaction as the status change, exactly as it is for a
 * change the chain caused. A merchant reconciling by webhook must not have to special-case the one
 * event they triggered themselves, and an event the documentation promises must actually be sent.
 */

export type CancelPaymentResult =
  | { readonly kind: 'canceled'; readonly payment: Payment }
  | { readonly kind: 'already_canceled'; readonly payment: Payment }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rejected'; readonly detail: string; readonly currentStatus: string };

export interface CancelPaymentDependencies {
  readonly paymentRepository: PaymentRepository;
  readonly paymentTransferRepository: PaymentTransferRepository;
  readonly ulidFactory: UlidFactory;
  readonly checkoutBaseUrl: string;
  readonly now: () => Date;
}

const MAXIMUM_ATTEMPTS = 5;

export class CancelPaymentUseCase {
  private readonly dependencies: CancelPaymentDependencies;

  constructor(dependencies: CancelPaymentDependencies) {
    this.dependencies = dependencies;
  }

  async execute(
    merchantId: string,
    environment: Environment,
    paymentId: string,
  ): Promise<CancelPaymentResult> {
    // A lost compare-and-swap means someone else moved the payment, so the decision is re-made
    // against what is now true rather than retried blindly. Bounded, because an unbounded retry
    // under contention is a livelock.
    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      const payment = await this.dependencies.paymentRepository.findById(
        merchantId,
        environment,
        paymentId,
      );
      if (payment === null) {
        return { kind: 'not_found' };
      }

      // Read from the ledger rather than inferred from the status. A transfer the scanner has
      // recorded but the evaluator has not yet acted on leaves the payment `pending`, and cancelling
      // it there would strand the customer's money at an address created for one invoice.
      const observed = await this.dependencies.paymentTransferRepository.findByPayment(
        payment.identifier,
      );
      const stillOnChain = observed.filter((transfer) => transfer.observation !== 'orphaned');
      const decision = cancelPayment(payment, stillOnChain.length);
      if (decision.kind === 'ignored') {
        return { kind: 'already_canceled', payment };
      }
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', detail: decision.reason, currentStatus: payment.status };
      }

      const now = this.dependencies.now();
      const saved = await this.dependencies.paymentRepository.saveTransition({
        payment: decision.payment,
        previousStatus: payment.status,
        expectedVersion: payment.statusVersion,
        command: decision.command,
        causedBy: merchantId,
        outbox: buildOutboxEntry({
          payment: decision.payment,
          eventType: `payment.${decision.payment.status}`,
          occurredAt: now,
          checkoutBaseUrl: this.dependencies.checkoutBaseUrl,
          ulidFactory: this.dependencies.ulidFactory,
        }),
      });
      if (saved) {
        return { kind: 'canceled', payment: decision.payment };
      }
    }

    return {
      kind: 'rejected',
      detail: 'The payment is being modified concurrently. Retry the request.',
      currentStatus: 'unknown',
    };
  }
}
