import { transition } from '@cryptopay/shared';

import { applied, ignored, rejected, type PaymentDecision } from './payment-decision.js';
import { isFinished, type Payment } from './payment.js';

/**
 * Pure commands over a payment. Each returns a decision rather than mutating, so the caller decides
 * what to persist and the whole lifecycle is testable without any infrastructure at all.
 */

function advance(payment: Payment, changes: Partial<Payment>): Payment {
  return Object.freeze({
    ...payment,
    ...changes,
    statusVersion: payment.statusVersion + 1,
  });
}

/**
 * Cancelling is only ever legal while nothing has been credited. A merchant cancelling a payment a
 * customer has already funded would strand the customer's money, so it is refused and the merchant
 * is told what the payment's current status is.
 */
export function cancelPayment(payment: Payment, observedTransferCount: number): PaymentDecision {
  if (payment.status === 'canceled') {
    return ignored('the payment is already canceled');
  }
  if (isFinished(payment)) {
    return rejected(`a ${payment.status} payment cannot be canceled`);
  }

  // The status alone is not enough. It only moves once the scanner has committed a transfer and the
  // evaluator has run, so between a customer's broadcast and that moment the payment is still
  // `pending` and every status check says cancelling is fine. Counting the transfers already
  // recorded closes most of that window; what it cannot close is the seconds before the scanner sees
  // the log at all, which is why funds arriving against a finished payment stay recoverable.
  if (observedTransferCount > 0) {
    return rejected('this payment has already received a transfer on chain and cannot be canceled');
  }

  const result = transition(payment.status, 'canceled', 'MERCHANT_CANCELED');
  if (result.kind !== 'allowed') {
    return rejected(
      `a payment that has received funds cannot be canceled while it is ${payment.status}`,
    );
  }

  const canceled = advance(payment, { status: 'canceled' });
  return applied(canceled, 'MERCHANT_CANCELED', 'cancelPayment', [
    {
      type: 'payment.canceled',
      paymentId: payment.identifier,
      statusVersion: canceled.statusVersion,
    },
  ]);
}

/**
 * Expiry is an ordinary state-machine input rather than a special case, so a payment that expires
 * and a transfer that lands in the same second race through the same write path and exactly one
 * wins.
 */
export function expirePayment(payment: Payment, now: Date): PaymentDecision {
  if (isFinished(payment)) {
    return ignored(`the payment is already ${payment.status}`);
  }
  if (now.getTime() < payment.expiresAt.getTime()) {
    return ignored('the payment has not expired yet');
  }

  // A payment holding sufficient funds is never expired by a clock. Doing so would take money the
  // customer has already sent.
  if (payment.status === 'confirming') {
    return ignored('the payment is funded and awaiting finality');
  }

  const target = payment.creditedAmountInBaseUnits > 0n ? 'underpaid' : 'expired';
  const result = transition(payment.status, target, 'EXPIRY_ELAPSED');
  if (result.kind !== 'allowed') {
    return rejected(`cannot move a ${payment.status} payment to ${target}`);
  }

  const expired = advance(payment, { status: target });
  return applied(expired, 'EXPIRY_ELAPSED', 'expirePayment', [
    {
      type: `payment.${target}`,
      paymentId: payment.identifier,
      statusVersion: expired.statusVersion,
    },
  ]);
}
