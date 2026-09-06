import { cancelPayment } from '../domain/payment-commands.js';
import type { Payment } from '../domain/payment.js';
import type { PaymentRepository } from '../infrastructure/persistence/payment.repository.js';

/**
 * Cancelling a payment. Legal only while nothing has been credited: cancelling a payment a customer
 * has already funded would strand their money.
 */

export type CancelPaymentResult =
  | { readonly kind: 'canceled'; readonly payment: Payment }
  | { readonly kind: 'already_canceled'; readonly payment: Payment }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rejected'; readonly detail: string; readonly currentStatus: string };

const MAXIMUM_ATTEMPTS = 5;

export class CancelPaymentUseCase {
  private readonly paymentRepository: PaymentRepository;

  constructor(paymentRepository: PaymentRepository) {
    this.paymentRepository = paymentRepository;
  }

  async execute(merchantId: string, paymentId: string): Promise<CancelPaymentResult> {
    // A lost compare-and-swap means someone else moved the payment, so the decision is re-made
    // against what is now true rather than retried blindly. Bounded, because an unbounded retry
    // under contention is a livelock.
    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      const payment = await this.paymentRepository.findById(merchantId, paymentId);
      if (payment === null) {
        return { kind: 'not_found' };
      }

      const decision = cancelPayment(payment);
      if (decision.kind === 'ignored') {
        return { kind: 'already_canceled', payment };
      }
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', detail: decision.reason, currentStatus: payment.status };
      }

      const saved = await this.paymentRepository.saveTransition({
        payment: decision.payment,
        previousStatus: payment.status,
        expectedVersion: payment.statusVersion,
        command: decision.command,
        causedBy: merchantId,
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
