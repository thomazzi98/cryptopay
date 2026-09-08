/**
 * A hard limit on how much native currency a network may spend from the treasury.
 *
 * This is not a test-only device. A payment processor that can sign transactions can, given a bug
 * or a compromised process, sign a great many of them, and every other control in this system is
 * about not paying the wrong person rather than about not paying too much in total. The ceiling is
 * the one control that bounds the blast radius by amount, and it is checked in the settlement path
 * before anything is signed, so no caller can route around it.
 *
 * What it counts is deliberately narrow: native currency leaving the treasury account. That is the
 * figure an operator can check against the balance they funded, and it needs no reconciliation
 * against anything.
 *
 * A sweep signed by a deposit address is not counted a second time. Its fee is paid out of exactly
 * the native currency the treasury sent it a moment earlier, which was already counted as value
 * leaving the treasury; counting both would refuse an operation at roughly half the configured
 * ceiling and the reason would be invisible.
 *
 * An unresolved transaction is counted at its worst case rather than at what it will probably cost.
 * A ceiling that can be crossed by transactions already in the mempool is not a ceiling.
 */

export interface TreasurySpend {
  /** Native currency sent, excluding fees. */
  readonly valueInNativeUnits: bigint;
  /** The upper bound computed before signing. */
  readonly maximumFeeInNativeUnits: bigint;
  /** What the receipt reported, once there is one. Null while the transaction is unresolved. */
  readonly feePaidInNativeUnits: bigint | null;
}

export interface ProposedSpend {
  readonly valueInNativeUnits: bigint;
  readonly maximumFeeInNativeUnits: bigint;
}

export type SpendDecision =
  | {
      readonly kind: 'permitted';
      readonly committedInNativeUnits: bigint;
      readonly remainingInNativeUnits: bigint;
    }
  | {
      readonly kind: 'refused';
      readonly committedInNativeUnits: bigint;
      readonly ceilingInNativeUnits: bigint;
      readonly wouldReachInNativeUnits: bigint;
    };

/** What one recorded transaction contributes: its receipt if it has one, its worst case if not. */
export function costOf(spend: TreasurySpend): bigint {
  const fee = spend.feePaidInNativeUnits ?? spend.maximumFeeInNativeUnits;
  return spend.valueInNativeUnits + fee;
}

export function totalCommitted(spends: readonly TreasurySpend[]): bigint {
  return spends.reduce((running, spend) => running + costOf(spend), 0n);
}

export interface SpendDecisionInput {
  /** Null means no ceiling is configured for this network, which permits everything. */
  readonly ceilingInNativeUnits: bigint | null;
  readonly committedInNativeUnits: bigint;
  readonly proposed: ProposedSpend;
}

export function decideSpend(input: SpendDecisionInput): SpendDecision {
  if (input.ceilingInNativeUnits === null) {
    return {
      kind: 'permitted',
      committedInNativeUnits: input.committedInNativeUnits,
      remainingInNativeUnits: 0n,
    };
  }

  const proposedCost = input.proposed.valueInNativeUnits + input.proposed.maximumFeeInNativeUnits;
  const wouldReach = input.committedInNativeUnits + proposedCost;

  // Strictly above, so a proposal that lands exactly on the ceiling is permitted. A ceiling nobody
  // can reach is a ceiling that was set one unit too low.
  if (wouldReach > input.ceilingInNativeUnits) {
    return {
      kind: 'refused',
      committedInNativeUnits: input.committedInNativeUnits,
      ceilingInNativeUnits: input.ceilingInNativeUnits,
      wouldReachInNativeUnits: wouldReach,
    };
  }

  return {
    kind: 'permitted',
    committedInNativeUnits: input.committedInNativeUnits,
    remainingInNativeUnits: input.ceilingInNativeUnits - wouldReach,
  };
}
