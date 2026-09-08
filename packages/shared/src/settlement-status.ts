/**
 * The six states a settlement can hold, and the edges between them.
 *
 * A settlement is the outbound half of a payment: moving what a customer sent from the address
 * allocated to them into the merchant's payout account. It is modelled separately from the payment
 * on purpose. A payment that completed is a fact about the chain and must never become uncertain
 * again because a sweep failed, so settlement failure lives here where it cannot reach it.
 *
 * The shape follows what actually has to happen on an EVM chain, which is two transactions rather
 * than one. A freshly derived deposit address holds no native currency, so it cannot pay for its own
 * ERC-20 transfer; the treasury sends it exactly enough first. `funding` is that transaction and
 * `sweeping` is the transfer itself.
 *
 * `failed` is not terminal, and that is the one deliberate difference from the payment machine. A
 * sweep that failed for want of gas, or against an endpoint that was down, is worth attempting again
 * once the cause is gone: the money is still sitting in an address this system controls, and giving
 * up on it permanently would strand it. Attempts are counted so retrying cannot become a loop, and
 * the funds are never at risk of being sent twice because the sequence number decides that, not the
 * status.
 */

export type SettlementStatus =
  'pending' | 'funding' | 'sweeping' | 'confirming' | 'settled' | 'failed';

export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = Object.freeze([
  'pending',
  'funding',
  'sweeping',
  'confirming',
  'settled',
  'failed',
]);

export function isSettlementStatus(value: string): value is SettlementStatus {
  return (SETTLEMENT_STATUSES as readonly string[]).includes(value);
}

/** Only one state is final. See the note above on why `failed` is not. */
export function isTerminalSettlementStatus(status: SettlementStatus): boolean {
  return status === 'settled';
}

/** Whether this settlement is waiting on something the chain has not answered yet. */
const AWAITING_CHAIN: readonly SettlementStatus[] = Object.freeze([
  'funding',
  'sweeping',
  'confirming',
]);

export function isAwaitingChain(status: SettlementStatus): boolean {
  return AWAITING_CHAIN.includes(status);
}

export type SettlementTrigger =
  | 'SETTLEMENT_PLANNED'
  | 'GAS_FUNDED'
  | 'SWEEP_BROADCAST'
  | 'SWEEP_MINED'
  | 'CONFIRMATIONS_REACHED'
  | 'ATTEMPT_FAILED'
  | 'RETRY_REQUESTED';

export const SETTLEMENT_TRIGGERS: readonly SettlementTrigger[] = Object.freeze([
  'SETTLEMENT_PLANNED',
  'GAS_FUNDED',
  'SWEEP_BROADCAST',
  'SWEEP_MINED',
  'CONFIRMATIONS_REACHED',
  'ATTEMPT_FAILED',
  'RETRY_REQUESTED',
]);

export interface SettlementTransition {
  readonly from: SettlementStatus;
  readonly to: SettlementStatus;
  readonly trigger: SettlementTrigger;
  readonly guard: string;
}

export const SETTLEMENT_TRANSITIONS: readonly SettlementTransition[] = Object.freeze([
  {
    from: 'pending',
    to: 'funding',
    trigger: 'SETTLEMENT_PLANNED',
    guard: 'the deposit address cannot cover the sweep fee and a funding transfer was broadcast',
  },
  {
    from: 'pending',
    to: 'sweeping',
    trigger: 'SETTLEMENT_PLANNED',
    guard: 'the deposit address already holds enough native currency, so no funding is needed',
  },
  {
    from: 'funding',
    to: 'sweeping',
    trigger: 'GAS_FUNDED',
    guard: 'the funding transfer is confirmed and the sweep was broadcast',
  },
  {
    from: 'sweeping',
    to: 'confirming',
    trigger: 'SWEEP_MINED',
    guard: 'the sweep is in a block and is accumulating confirmations',
  },
  {
    from: 'confirming',
    to: 'settled',
    trigger: 'CONFIRMATIONS_REACHED',
    guard: 'the sweep has the required confirmations and the block is covered by finality',
  },
  {
    from: 'pending',
    to: 'failed',
    trigger: 'ATTEMPT_FAILED',
    guard: 'planning could not proceed, for instance no payout destination is configured',
  },
  {
    from: 'funding',
    to: 'failed',
    trigger: 'ATTEMPT_FAILED',
    guard: 'the funding transfer reverted, or the treasury cannot cover it',
  },
  {
    from: 'sweeping',
    to: 'failed',
    trigger: 'ATTEMPT_FAILED',
    guard: 'the sweep reverted on chain',
  },
  {
    from: 'confirming',
    to: 'failed',
    trigger: 'ATTEMPT_FAILED',
    guard: 'a reorg removed the sweep after it had been mined',
  },
  {
    from: 'failed',
    to: 'pending',
    trigger: 'RETRY_REQUESTED',
    guard:
      'an operator or the retry schedule asks for another attempt, and the funds are still there',
  },
]);

const ALLOWED_EDGES: ReadonlySet<string> = new Set(
  SETTLEMENT_TRANSITIONS.map((transition) => `${transition.from}->${transition.to}`),
);

/**
 * Whether an edge exists at all. The repository additionally requires the status version to match,
 * so a transition that is legal in the abstract still loses to a concurrent writer.
 */
export function canTransitionSettlement(from: SettlementStatus, to: SettlementStatus): boolean {
  return ALLOWED_EDGES.has(`${from}->${to}`);
}

export function allowedSettlementTargetsFrom(from: SettlementStatus): readonly SettlementStatus[] {
  return SETTLEMENT_TRANSITIONS.filter((transition) => transition.from === from).map(
    (transition) => transition.to,
  );
}
