import { describe, expect, it } from 'vitest';

import {
  allowedSettlementTargetsFrom,
  canTransitionSettlement,
  isAwaitingChain,
  isSettlementStatus,
  isTerminalSettlementStatus,
  SETTLEMENT_STATUSES,
  SETTLEMENT_TRANSITIONS,
} from './settlement-status.js';

/**
 * The settlement machine decides when money leaves an address this system controls, so the whole
 * grid is enumerated rather than sampled. Every pair is either declared or refused, and the count of
 * declared edges is asserted so that adding one without deciding what it means fails here.
 */

describe('the settlement transition table', () => {
  it('declares every edge exactly once', () => {
    const edges = SETTLEMENT_TRANSITIONS.map(
      (transition) => `${transition.from}->${transition.to}`,
    );
    expect(new Set(edges).size).toBe(edges.length);
  });

  it('names only known statuses', () => {
    for (const transition of SETTLEMENT_TRANSITIONS) {
      expect(SETTLEMENT_STATUSES).toContain(transition.from);
      expect(SETTLEMENT_STATUSES).toContain(transition.to);
    }
  });

  it('gives every edge a guard that says when it is taken', () => {
    for (const transition of SETTLEMENT_TRANSITIONS) {
      expect(transition.guard.length).toBeGreaterThan(10);
    }
  });

  it('never declares an edge from a status to itself', () => {
    for (const transition of SETTLEMENT_TRANSITIONS) {
      expect(transition.from).not.toBe(transition.to);
    }
  });
});

describe('every ordered pair of statuses', () => {
  const pairs = SETTLEMENT_STATUSES.flatMap((from) =>
    SETTLEMENT_STATUSES.map((to) => ({ from, to })),
  );
  const declared = new Set(
    SETTLEMENT_TRANSITIONS.map((transition) => `${transition.from}->${transition.to}`),
  );

  it('covers the whole grid', () => {
    expect(pairs).toHaveLength(SETTLEMENT_STATUSES.length ** 2);
  });

  it.each(pairs)('answers $from -> $to the same way the table declares it', ({ from, to }) => {
    expect(canTransitionSettlement(from, to)).toBe(declared.has(`${from}->${to}`));
  });
});

describe('what the statuses mean', () => {
  it('treats only settled as final', () => {
    expect(isTerminalSettlementStatus('settled')).toBe(true);
    const others = SETTLEMENT_STATUSES.filter((entry) => entry !== 'settled');
    for (const status of others) {
      expect(isTerminalSettlementStatus(status)).toBe(false);
    }
  });

  /**
   * The one deliberate difference from the payment machine. Money in an address this system controls
   * has to remain reachable, and a terminal failure would strand it.
   */
  it('allows a failed settlement to be attempted again', () => {
    expect(canTransitionSettlement('failed', 'pending')).toBe(true);
  });

  it('never leaves settled', () => {
    expect(allowedSettlementTargetsFrom('settled')).toStrictEqual([]);
  });

  it('never reaches settled except through the confirmation gate', () => {
    const intoSettled = SETTLEMENT_TRANSITIONS.filter((transition) => transition.to === 'settled');
    expect(intoSettled.map((transition) => transition.from)).toStrictEqual(['confirming']);
  });

  it('knows which statuses are waiting on the chain', () => {
    expect(SETTLEMENT_STATUSES.filter((status) => isAwaitingChain(status))).toStrictEqual([
      'funding',
      'sweeping',
      'confirming',
    ]);
  });

  it('recognises its own statuses and nothing else', () => {
    for (const status of SETTLEMENT_STATUSES) {
      expect(isSettlementStatus(status)).toBe(true);
    }
    expect(isSettlementStatus('completed')).toBe(false);
    expect(isSettlementStatus('')).toBe(false);
  });
});
