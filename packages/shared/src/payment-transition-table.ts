import { PAYMENT_STATUSES, type PaymentStatus } from './payment-status.js';

/**
 * The complete set of status-changing edges a payment may take, and the only place they are
 * declared. The API's state machine and the documentation generator both read this table, so the
 * documented lifecycle cannot drift from the enforced one.
 *
 * Five design calls are load-bearing and deliberate:
 *
 * 1. `confirming` cannot expire. Once sufficient value is on chain, a timer firing is irrelevant;
 *    expiring a funded payment because a clock advanced is stealing.
 * 2. There is no edge out of any terminal status. A transfer arriving against a finished payment is
 *    recorded and reported, never applied. Resurrection edges are the bug class that double-credits.
 * 3. `partially_funded` is separate from `underpaid` precisely so that no `underpaid -> completed`
 *    edge is ever needed: a top-up before expiry moves within the non-terminal states.
 * 4. There is no `failed` status. A reverted ERC-20 transfer emits no Transfer event at all, so it
 *    is never observed and there is nothing to fail. Settlement failure lives in an orthogonal
 *    column that cannot corrupt a completed payment.
 * 5. Multiple transfers are summed rather than treated as exceptional, which removes the need for
 *    an unresolved "multiple payments" status entirely.
 */

export type PaymentTrigger =
  | 'TRANSFER_CREDITED'
  | 'TRANSFERS_ORPHANED'
  | 'CHAIN_PROGRESS_OBSERVED'
  | 'EXPIRY_ELAPSED'
  | 'MERCHANT_CANCELED';

export const PAYMENT_TRIGGERS: readonly PaymentTrigger[] = Object.freeze([
  'TRANSFER_CREDITED',
  'TRANSFERS_ORPHANED',
  'CHAIN_PROGRESS_OBSERVED',
  'EXPIRY_ELAPSED',
  'MERCHANT_CANCELED',
]);

export interface PaymentTransition {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
  readonly trigger: PaymentTrigger;
  /** The condition that must hold for this edge to be taken. Rendered into the generated docs. */
  readonly guard: string;
}

export const PAYMENT_TRANSITIONS: readonly PaymentTransition[] = Object.freeze([
  {
    from: 'pending',
    to: 'partially_funded',
    trigger: 'TRANSFER_CREDITED',
    guard: 'credited amount is above zero but below the acceptance band',
  },
  {
    from: 'pending',
    to: 'confirming',
    trigger: 'TRANSFER_CREDITED',
    guard: 'credited amount reaches the acceptance band',
  },
  {
    from: 'pending',
    to: 'expired',
    trigger: 'EXPIRY_ELAPSED',
    guard: 'expiry has elapsed with nothing credited',
  },
  {
    from: 'pending',
    to: 'canceled',
    trigger: 'MERCHANT_CANCELED',
    guard: 'the merchant cancels while nothing is credited',
  },
  {
    from: 'partially_funded',
    to: 'confirming',
    trigger: 'TRANSFER_CREDITED',
    guard: 'a further transfer brings the credited amount into the acceptance band',
  },
  {
    from: 'partially_funded',
    to: 'pending',
    trigger: 'TRANSFERS_ORPHANED',
    guard: 'a reorg withdraws every credited transfer',
  },
  {
    from: 'partially_funded',
    to: 'underpaid',
    trigger: 'EXPIRY_ELAPSED',
    guard: 'expiry has elapsed with value credited but below the acceptance band',
  },
  {
    from: 'confirming',
    to: 'completed',
    trigger: 'CHAIN_PROGRESS_OBSERVED',
    guard: 'the finality gate opens and the credited amount is within the acceptance band',
  },
  {
    from: 'confirming',
    to: 'overpaid',
    trigger: 'CHAIN_PROGRESS_OBSERVED',
    guard: 'the finality gate opens and the credited amount exceeds the acceptance band',
  },
  {
    from: 'confirming',
    to: 'partially_funded',
    trigger: 'TRANSFERS_ORPHANED',
    guard: 'a reorg drops the credited amount below the acceptance band but above zero',
  },
  {
    from: 'confirming',
    to: 'pending',
    trigger: 'TRANSFERS_ORPHANED',
    guard: 'a reorg withdraws every credited transfer',
  },
]);

function buildAllowedTransitions(): Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> {
  // Seeded with every status, so a terminal status maps to an empty set rather than to undefined.
  // Without that seeding, a lookup would be typed as a set and be undefined at runtime.
  const allowed = {} as Record<PaymentStatus, Set<PaymentStatus>>;
  for (const status of PAYMENT_STATUSES) {
    allowed[status] = new Set<PaymentStatus>();
  }
  for (const edge of PAYMENT_TRANSITIONS) {
    allowed[edge.from].add(edge.to);
  }
  return Object.freeze(allowed);
}

/** Derived from the table above so the two can never disagree. */
export const ALLOWED_TRANSITIONS = buildAllowedTransitions();
