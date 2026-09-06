import type { PaymentTrigger } from '@cryptopay/shared';

import type { Payment } from './payment.js';

/**
 * The result of applying a command to a payment.
 *
 * A discriminated union rather than an exception, because in an at-least-once pipeline that rescans
 * block ranges, re-applying a command that already took effect is the ordinary path and not an
 * error. Callers switch on the tag, which also keeps control flow free of `else`.
 */

export interface PaymentEvent {
  readonly type: string;
  readonly paymentId: string;
  readonly statusVersion: number;
}

export type PaymentDecision =
  | {
      readonly kind: 'applied';
      readonly payment: Payment;
      readonly trigger: PaymentTrigger;
      readonly command: string;
      readonly events: readonly PaymentEvent[];
    }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export function applied(
  payment: Payment,
  trigger: PaymentTrigger,
  command: string,
  events: readonly PaymentEvent[],
): PaymentDecision {
  return { kind: 'applied', payment, trigger, command, events };
}

export function ignored(reason: string): PaymentDecision {
  return { kind: 'ignored', reason };
}

export function rejected(reason: string): PaymentDecision {
  return { kind: 'rejected', reason };
}
