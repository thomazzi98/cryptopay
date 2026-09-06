/**
 * The eight states a payment can hold.
 *
 * The set is deliberately small and every terminal state is genuinely terminal: there is no edge
 * out of one. Resurrection edges are the bug class that produces double-crediting, so a transfer
 * arriving against a finished payment is recorded and reported, never applied.
 */

export type PaymentStatus =
  | 'pending'
  | 'partially_funded'
  | 'confirming'
  | 'completed'
  | 'overpaid'
  | 'underpaid'
  | 'expired'
  | 'canceled';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'pending',
  'partially_funded',
  'confirming',
  'completed',
  'overpaid',
  'underpaid',
  'expired',
  'canceled',
]);

const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'completed',
  'overpaid',
  'underpaid',
  'expired',
  'canceled',
]);

/**
 * Imported by both the API's state machine and the dashboard's polling hook, so the two cannot
 * disagree about when to stop asking.
 */
export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.has(status);
}

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether a payment in this state has value credited against it. Drives whether expiry produces
 * `expired` or `underpaid`, and whether cancellation is still allowed.
 */
export function hasCreditedValue(status: PaymentStatus): boolean {
  return status !== 'pending' && status !== 'expired' && status !== 'canceled';
}
