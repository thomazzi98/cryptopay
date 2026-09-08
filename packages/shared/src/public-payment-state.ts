import { PAYMENT_STATUSES, type PaymentStatus } from './payment-status.js';
import { PAYMENT_TRANSITIONS } from './payment-transition-table.js';

/**
 * The lifecycle a payment gateway integrating with CryptoPay sees.
 *
 * This is a projection of the internal eight-status machine, not a second machine. Every public
 * edge below is computed by projecting a real internal edge, so the published lifecycle cannot
 * describe a transition the engine will not make, and cannot omit one it will. Hand-writing the
 * public table would have allowed exactly that drift, and the drift is invisible until a merchant
 * builds on a state change that never arrives.
 *
 * The projection is deliberately lossy in two places, and both are compensated in the DTO rather
 * than hidden:
 *
 * - PAID covers `completed` and `overpaid`. A gateway that ships goods on PAID without reading
 *   `amountReceived` would ship on an overpayment, which is usually correct and is the merchant's
 *   call, not ours. The received and expected amounts always travel with the state.
 * - FAILED covers `underpaid`. The money is real and is still at the destination; the payment
 *   simply never reached the acceptance band before it expired. `failureReason` says which.
 */

export type PublicPaymentState =
  | 'CREATED'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_DETECTED'
  | 'CONFIRMING'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED';

export const PUBLIC_PAYMENT_STATES: readonly PublicPaymentState[] = Object.freeze([
  'CREATED',
  'WAITING_FOR_PAYMENT',
  'PAYMENT_DETECTED',
  'CONFIRMING',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

const TERMINAL_PUBLIC_STATES: ReadonlySet<PublicPaymentState> = new Set<PublicPaymentState>([
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

export function isTerminalPublicState(state: PublicPaymentState): boolean {
  return TERMINAL_PUBLIC_STATES.has(state);
}

/**
 * Why a payment ended without being paid. Reported beside FAILED, which otherwise cannot be acted
 * on: an underpayment needs a refund decision, and an unusable destination needs a new payment.
 */
export type PaymentFailureReason = 'insufficient_amount';

const PROJECTION: Readonly<Record<PaymentStatus, PublicPaymentState>> = Object.freeze({
  pending: 'WAITING_FOR_PAYMENT',
  partially_funded: 'PAYMENT_DETECTED',
  confirming: 'CONFIRMING',
  completed: 'PAID',
  overpaid: 'PAID',
  underpaid: 'FAILED',
  expired: 'EXPIRED',
  canceled: 'CANCELLED',
});

export interface PublicStateInput {
  readonly status: PaymentStatus;
  /**
   * Whether the network's scanner has advanced far enough to be watching this payment's
   * destination yet.
   *
   * This is the whole difference between CREATED and WAITING_FOR_PAYMENT, and it is a real
   * operational distinction rather than a cosmetic one: paying a destination the scanner has not
   * reached still works, but the payment is detected on catch-up rather than promptly. A gateway
   * that shows its customer a QR code before this is true is showing one that may sit unnoticed.
   */
  readonly monitoringHasReachedCreation: boolean;
}

export function toPublicPaymentState(input: PublicStateInput): PublicPaymentState {
  const projected = PROJECTION[input.status];
  if (projected === 'WAITING_FOR_PAYMENT' && !input.monitoringHasReachedCreation) {
    return 'CREATED';
  }
  return projected;
}

export interface PublicPaymentTransition {
  readonly from: PublicPaymentState;
  readonly to: PublicPaymentState;
}

function projectionsOf(status: PaymentStatus): readonly PublicPaymentState[] {
  const projected = PROJECTION[status];
  // `pending` is the one internal status that shows two faces, so an edge touching it projects to
  // both and the public table admits whichever the reader is actually in.
  if (projected === 'WAITING_FOR_PAYMENT') {
    return ['CREATED', 'WAITING_FOR_PAYMENT'];
  }
  return [projected];
}

function buildPublicTransitions(): readonly PublicPaymentTransition[] {
  const seen = new Set<string>();
  const transitions: PublicPaymentTransition[] = [];

  for (const edge of PAYMENT_TRANSITIONS) {
    for (const from of projectionsOf(edge.from)) {
      for (const to of projectionsOf(edge.to)) {
        // An internal edge whose ends share a public state is invisible from outside. Recording it
        // would publish a self-loop that no observer can ever see happen.
        const key = `${from}>${to}`;
        if (from !== to && !seen.has(key)) {
          seen.add(key);
          transitions.push({ from, to });
        }
      }
    }
  }

  // A payment is created before its network has been observed reaching it, so this is the one edge
  // driven by the scanner catching up rather than by a status change.
  transitions.push({ from: 'CREATED', to: 'WAITING_FOR_PAYMENT' });
  return Object.freeze(transitions);
}

export const PUBLIC_PAYMENT_TRANSITIONS: readonly PublicPaymentTransition[] =
  buildPublicTransitions();

type AllowedMap = Readonly<Record<PublicPaymentState, ReadonlySet<PublicPaymentState>>>;

function buildAllowed(): AllowedMap {
  const allowed = {} as Record<PublicPaymentState, Set<PublicPaymentState>>;
  for (const state of PUBLIC_PAYMENT_STATES) {
    allowed[state] = new Set<PublicPaymentState>();
  }
  for (const transition of PUBLIC_PAYMENT_TRANSITIONS) {
    allowed[transition.from].add(transition.to);
  }
  return Object.freeze(allowed);
}

export const ALLOWED_PUBLIC_TRANSITIONS = buildAllowed();

export function isPublicTransitionAllowed(
  from: PublicPaymentState,
  to: PublicPaymentState,
): boolean {
  return ALLOWED_PUBLIC_TRANSITIONS[from].has(to);
}

/**
 * Every internal status projects, so a new one cannot be added without deciding what it looks like
 * from outside. The compiler already requires the key to exist; this asserts the value is one of
 * the published states rather than something a careless edit left behind.
 */
export function assertProjectionIsTotal(): void {
  for (const status of PAYMENT_STATUSES) {
    if (!PUBLIC_PAYMENT_STATES.includes(PROJECTION[status])) {
      throw new Error(`No public state is declared for the internal status ${status}`);
    }
  }
}
