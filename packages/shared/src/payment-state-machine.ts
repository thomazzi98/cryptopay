import { isTerminalPaymentStatus, type PaymentStatus } from './payment-status.js';
import {
  PAYMENT_TRANSITIONS,
  type PaymentTransition,
  type PaymentTrigger,
} from './payment-transition-table.js';

/**
 * The pure state machine. It answers one question — may this payment move from here to there, driven
 * by this trigger — and it is the only thing permitted to answer it. Status is never assigned
 * anywhere else in the system.
 *
 * The result is a discriminated union rather than an exception because, in an at-least-once
 * pipeline that rescans block ranges, re-applying a transition that already happened is the normal
 * path and not an error. Callers switch on the tag, which also keeps control flow free of `else`.
 */

export type TransitionResult =
  | { readonly kind: 'allowed'; readonly transition: PaymentTransition }
  | { readonly kind: 'unchanged'; readonly status: PaymentStatus }
  | { readonly kind: 'rejected'; readonly reason: string };

export class InvalidPaymentTransitionError extends Error {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;

  constructor(from: PaymentStatus, to: PaymentStatus, reason: string) {
    super(`Cannot move a payment from ${from} to ${to}: ${reason}`);
    this.name = 'InvalidPaymentTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function findTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  trigger: PaymentTrigger,
): PaymentTransition | null {
  return (
    PAYMENT_TRANSITIONS.find(
      (candidate) =>
        candidate.from === from && candidate.to === to && candidate.trigger === trigger,
    ) ?? null
  );
}

export function isTransitionAllowed(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS.some((candidate) => candidate.from === from && candidate.to === to);
}

/** Every status reachable from this one in a single step. */
export function allowedTargetsFrom(from: PaymentStatus): readonly PaymentStatus[] {
  const targets = PAYMENT_TRANSITIONS.filter((candidate) => candidate.from === from).map(
    (candidate) => candidate.to,
  );
  return Object.freeze([...new Set(targets)]);
}

/** Every trigger that can move a payment out of this status. */
export function triggersFrom(from: PaymentStatus): readonly PaymentTrigger[] {
  const triggers = PAYMENT_TRANSITIONS.filter((candidate) => candidate.from === from).map(
    (candidate) => candidate.trigger,
  );
  return Object.freeze([...new Set(triggers)]);
}

export function transition(
  from: PaymentStatus,
  to: PaymentStatus,
  trigger: PaymentTrigger,
): TransitionResult {
  if (from === to) {
    return { kind: 'unchanged', status: from };
  }
  if (isTerminalPaymentStatus(from)) {
    return {
      kind: 'rejected',
      reason: `${from} is terminal and has no outgoing transitions`,
    };
  }

  const matched = findTransition(from, to, trigger);
  if (matched !== null) {
    return { kind: 'allowed', transition: matched };
  }
  if (isTransitionAllowed(from, to)) {
    return {
      kind: 'rejected',
      reason: `the ${from} to ${to} transition exists but is not driven by ${trigger}`,
    };
  }
  return { kind: 'rejected', reason: `no transition from ${from} to ${to} is declared` };
}

/**
 * For the write path, where a rejected transition means a genuine programming error rather than a
 * replayed event. Read paths use `transition` and switch on the tag instead.
 */
export function assertTransition(
  from: PaymentStatus,
  to: PaymentStatus,
  trigger: PaymentTrigger,
): PaymentTransition {
  const result = transition(from, to, trigger);
  if (result.kind === 'allowed') {
    return result.transition;
  }
  if (result.kind === 'unchanged') {
    throw new InvalidPaymentTransitionError(from, to, 'the status is already set');
  }
  throw new InvalidPaymentTransitionError(from, to, result.reason);
}
