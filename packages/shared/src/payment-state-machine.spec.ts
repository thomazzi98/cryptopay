import { describe, expect, it } from 'vitest';

import { isTerminalPaymentStatus, PAYMENT_STATUSES, type PaymentStatus } from './payment-status.js';
import {
  allowedTargetsFrom,
  assertTransition,
  findTransition,
  InvalidPaymentTransitionError,
  isTransitionAllowed,
  transition,
  triggersFrom,
} from './payment-state-machine.js';
import {
  ALLOWED_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  PAYMENT_TRIGGERS,
} from './payment-transition-table.js';

const EXPECTED_EDGE_COUNT = 11;

const alphabetically = (left: string, right: string): number => left.localeCompare(right);

function growReachableSet(reached: Set<PaymentStatus>): boolean {
  let grew = false;
  for (const edge of PAYMENT_TRANSITIONS) {
    if (!reached.has(edge.from) || reached.has(edge.to)) {
      continue;
    }
    reached.add(edge.to);
    grew = true;
  }
  return grew;
}

function statusesReachableFromPending(): readonly PaymentStatus[] {
  const reached = new Set<PaymentStatus>(['pending']);
  while (growReachableSet(reached)) {
    // Keep widening until a pass adds nothing.
  }
  return [...reached];
}

const attemptTerminalTransition = () =>
  assertTransition('completed', 'pending', 'TRANSFERS_ORPHANED');

interface OrderedPair {
  readonly from: PaymentStatus;
  readonly to: PaymentStatus;
}

const ALL_ORDERED_PAIRS: readonly OrderedPair[] = PAYMENT_STATUSES.flatMap((from) =>
  PAYMENT_STATUSES.map((to) => ({ from, to })),
);

const DISTINCT_PAIRS = ALL_ORDERED_PAIRS.filter((pair) => pair.from !== pair.to);

function anyTriggerAllows(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRIGGERS.some((trigger) => transition(from, to, trigger).kind === 'allowed');
}

describe('the transition table itself', () => {
  it('declares exactly eleven status-changing edges', () => {
    expect(PAYMENT_TRANSITIONS).toHaveLength(EXPECTED_EDGE_COUNT);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PAYMENT_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(ALLOWED_TRANSITIONS)).toBe(true);
  });

  it('declares no edge twice', () => {
    const keys = PAYMENT_TRANSITIONS.map((edge) => `${edge.from}->${edge.to}:${edge.trigger}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares no self-edge, since an unchanged status is not a transition', () => {
    expect(PAYMENT_TRANSITIONS.filter((edge) => edge.from === edge.to)).toHaveLength(0);
  });

  it('references only declared statuses and triggers', () => {
    for (const edge of PAYMENT_TRANSITIONS) {
      expect(PAYMENT_STATUSES).toContain(edge.from);
      expect(PAYMENT_STATUSES).toContain(edge.to);
      expect(PAYMENT_TRIGGERS).toContain(edge.trigger);
    }
  });

  it('gives every edge a non-empty guard, because the guard is the documentation', () => {
    for (const edge of PAYMENT_TRANSITIONS) {
      expect(edge.guard.trim().length).toBeGreaterThan(0);
    }
  });

  // Terminal statuses have no outgoing edges, so a map built only from the edge list would leave
  // them absent while the type claims otherwise, and a lookup would be undefined at runtime.
  it('gives every status an entry in ALLOWED_TRANSITIONS, empty where terminal', () => {
    for (const status of PAYMENT_STATUSES) {
      const targets = ALLOWED_TRANSITIONS[status];
      expect(targets).toBeInstanceOf(Set);
      expect(targets.size).toBe(isTerminalPaymentStatus(status) ? 0 : targets.size);
    }
    expect(Object.keys(ALLOWED_TRANSITIONS)).toHaveLength(PAYMENT_STATUSES.length);
  });

  it('derives ALLOWED_TRANSITIONS from the same edges', () => {
    const derivedCount = Object.values(ALLOWED_TRANSITIONS).reduce(
      (total, targets) => total + targets.size,
      0,
    );
    expect(derivedCount).toBe(EXPECTED_EDGE_COUNT);
  });
});

describe('the full 8x8 enumeration', () => {
  it('covers all sixty-four ordered pairs', () => {
    expect(ALL_ORDERED_PAIRS).toHaveLength(64);
    expect(DISTINCT_PAIRS).toHaveLength(56);
  });

  it('allows exactly eleven of the fifty-six distinct pairs', () => {
    const allowed = DISTINCT_PAIRS.filter((pair) => anyTriggerAllows(pair.from, pair.to));
    expect(allowed).toHaveLength(EXPECTED_EDGE_COUNT);
  });

  it('rejects the other forty-five distinct pairs under every trigger', () => {
    const rejected = DISTINCT_PAIRS.filter((pair) => !anyTriggerAllows(pair.from, pair.to));
    expect(rejected).toHaveLength(45);

    for (const pair of rejected) {
      for (const trigger of PAYMENT_TRIGGERS) {
        const result = transition(pair.from, pair.to, trigger);
        expect(result.kind).toBe('rejected');
      }
    }
  });

  it.each(PAYMENT_STATUSES)('reports %s to itself as unchanged under every trigger', (status) => {
    for (const trigger of PAYMENT_TRIGGERS) {
      expect(transition(status, status, trigger)).toStrictEqual({ kind: 'unchanged', status });
    }
  });

  it.each(DISTINCT_PAIRS)(
    'agrees with isTransitionAllowed for $from to $to',
    ({ from, to }: OrderedPair) => {
      expect(isTransitionAllowed(from, to)).toBe(anyTriggerAllows(from, to));
    },
  );
});

describe('each declared edge', () => {
  it.each(PAYMENT_TRANSITIONS)('allows $from to $to under $trigger', ({ from, to, trigger }) => {
    const result = transition(from, to, trigger);
    expect(result.kind).toBe('allowed');
    expect(findTransition(from, to, trigger)).not.toBeNull();
  });

  it.each(PAYMENT_TRANSITIONS)(
    'rejects $from to $to under any trigger other than $trigger',
    ({ from, to, trigger }) => {
      const otherTriggers = PAYMENT_TRIGGERS.filter((candidate) => candidate !== trigger);

      for (const candidate of otherTriggers) {
        const declaredUnderCandidate = findTransition(from, to, candidate) !== null;
        const result = transition(from, to, candidate);
        const expected = declaredUnderCandidate ? 'allowed' : 'rejected';
        expect(result.kind).toBe(expected);
      }
    },
  );
});

describe('terminal statuses', () => {
  const terminal = PAYMENT_STATUSES.filter((status) => isTerminalPaymentStatus(status));

  it('finds the five terminal statuses', () => {
    expect(terminal).toHaveLength(5);
  });

  it.each(terminal)('%s has no outgoing edge in the table', (status) => {
    expect(PAYMENT_TRANSITIONS.filter((edge) => edge.from === status)).toHaveLength(0);
    expect(allowedTargetsFrom(status)).toHaveLength(0);
    expect(triggersFrom(status)).toHaveLength(0);
  });

  it.each(terminal)('%s rejects every move to every other status', (status) => {
    for (const target of PAYMENT_STATUSES) {
      if (target === status) {
        continue;
      }
      for (const trigger of PAYMENT_TRIGGERS) {
        const result = transition(status, target, trigger);
        expect(result.kind).toBe('rejected');
        expect(result).toHaveProperty('reason', expect.stringContaining('terminal'));
      }
    }
  });

  // The specific edge that would double-credit a merchant: a late transfer must never revive a
  // finished payment.
  it('refuses to revive an expired payment into completed', () => {
    expect(transition('expired', 'completed', 'TRANSFER_CREDITED').kind).toBe('rejected');
    expect(transition('underpaid', 'completed', 'TRANSFER_CREDITED').kind).toBe('rejected');
    expect(transition('canceled', 'confirming', 'TRANSFER_CREDITED').kind).toBe('rejected');
  });
});

describe('reachability', () => {
  it('reaches every status from pending', () => {
    expect(statusesReachableFromPending().toSorted(alphabetically)).toStrictEqual(
      [...PAYMENT_STATUSES].toSorted(alphabetically),
    );
  });

  it('never lets a funded payment expire', () => {
    expect(transition('confirming', 'expired', 'EXPIRY_ELAPSED').kind).toBe('rejected');
    expect(transition('confirming', 'canceled', 'MERCHANT_CANCELED').kind).toBe('rejected');
  });

  it('expires an unfunded payment but underpays a partly funded one', () => {
    expect(transition('pending', 'expired', 'EXPIRY_ELAPSED').kind).toBe('allowed');
    expect(transition('partially_funded', 'underpaid', 'EXPIRY_ELAPSED').kind).toBe('allowed');
    expect(transition('partially_funded', 'expired', 'EXPIRY_ELAPSED').kind).toBe('rejected');
  });

  it('walks a reorg back down through the non-terminal states', () => {
    expect(transition('confirming', 'partially_funded', 'TRANSFERS_ORPHANED').kind).toBe('allowed');
    expect(transition('confirming', 'pending', 'TRANSFERS_ORPHANED').kind).toBe('allowed');
    expect(transition('partially_funded', 'pending', 'TRANSFERS_ORPHANED').kind).toBe('allowed');
  });

  it('cancels only from pending', () => {
    expect(transition('pending', 'canceled', 'MERCHANT_CANCELED').kind).toBe('allowed');
    for (const from of ['partially_funded', 'confirming'] as PaymentStatus[]) {
      expect(transition(from, 'canceled', 'MERCHANT_CANCELED').kind).toBe('rejected');
    }
  });
});

describe('describing the options out of a status', () => {
  // These back the 409 response that tells a merchant what they could have done instead, so they
  // are part of the API contract rather than a convenience.
  it('lists the targets reachable from pending', () => {
    expect([...allowedTargetsFrom('pending')].toSorted(alphabetically)).toStrictEqual(
      ['canceled', 'confirming', 'expired', 'partially_funded'].toSorted(alphabetically),
    );
  });

  it('lists the targets reachable from confirming', () => {
    expect([...allowedTargetsFrom('confirming')].toSorted(alphabetically)).toStrictEqual(
      ['completed', 'overpaid', 'partially_funded', 'pending'].toSorted(alphabetically),
    );
  });

  it('lists the triggers that move a payment out of pending', () => {
    expect([...triggersFrom('pending')].toSorted(alphabetically)).toStrictEqual(
      ['EXPIRY_ELAPSED', 'MERCHANT_CANCELED', 'TRANSFER_CREDITED'].toSorted(alphabetically),
    );
  });

  it('deduplicates targets reachable under more than one trigger', () => {
    const targets = allowedTargetsFrom('confirming');
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('deduplicates triggers that drive more than one edge', () => {
    const triggers = triggersFrom('confirming');
    expect(new Set(triggers).size).toBe(triggers.length);
    expect(triggers).toContain('CHAIN_PROGRESS_OBSERVED');
    expect(triggers).toContain('TRANSFERS_ORPHANED');
  });

  it('returns frozen collections', () => {
    expect(Object.isFrozen(allowedTargetsFrom('pending'))).toBe(true);
    expect(Object.isFrozen(triggersFrom('pending'))).toBe(true);
  });

  it('agrees with the table for every status', () => {
    for (const status of PAYMENT_STATUSES) {
      const declared = new Set(
        PAYMENT_TRANSITIONS.filter((edge) => edge.from === status).map((edge) => edge.to),
      );
      expect(new Set(allowedTargetsFrom(status))).toStrictEqual(declared);
    }
  });
});

describe('assertTransition', () => {
  it('returns the matched edge when the move is legal', () => {
    const edge = assertTransition('pending', 'confirming', 'TRANSFER_CREDITED');
    expect(edge.from).toBe('pending');
    expect(edge.to).toBe('confirming');
  });

  it('throws for a move that is not declared', () => {
    expect(() => assertTransition('pending', 'completed', 'TRANSFER_CREDITED')).toThrow(
      InvalidPaymentTransitionError,
    );
  });

  it('throws for a legal edge driven by the wrong trigger', () => {
    expect(() => assertTransition('pending', 'expired', 'TRANSFER_CREDITED')).toThrow(
      /not driven by/,
    );
  });

  it('throws when the status is already set', () => {
    expect(() => assertTransition('confirming', 'confirming', 'TRANSFER_CREDITED')).toThrow(
      /already set/,
    );
  });

  it('carries the offending statuses on the error', () => {
    expect(attemptTerminalTransition).toThrow(InvalidPaymentTransitionError);
    expect(attemptTerminalTransition).toThrow(
      expect.objectContaining({ from: 'completed', to: 'pending' }),
    );
  });
});
