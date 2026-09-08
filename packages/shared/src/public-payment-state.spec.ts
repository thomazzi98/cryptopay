import { describe, expect, it } from 'vitest';

import { PAYMENT_STATUSES, type PaymentStatus } from './payment-status.js';
import {
  ALLOWED_PUBLIC_TRANSITIONS,
  assertProjectionIsTotal,
  isPublicTransitionAllowed,
  isTerminalPublicState,
  PUBLIC_PAYMENT_STATES,
  PUBLIC_PAYMENT_TRANSITIONS,
  toPublicPaymentState,
  type PublicPaymentState,
} from './public-payment-state.js';

/**
 * The public lifecycle is a projection of the internal machine rather than a second machine, so
 * these tests check two different things: that the projection is total and stable, and that the
 * derived edge set both contains every transition the contract promises and excludes every one it
 * forbids. The full eight-by-eight enumeration is what makes the second claim exhaustive rather
 * than anecdotal.
 */

function project(status: PaymentStatus, monitoringHasReachedCreation = true): PublicPaymentState {
  return toPublicPaymentState({ status, monitoringHasReachedCreation });
}

describe('projecting an internal status onto the public vocabulary', () => {
  it('has an answer for every internal status', () => {
    expect(() => {
      assertProjectionIsTotal();
    }).not.toThrow();
    for (const status of PAYMENT_STATUSES) {
      expect(PUBLIC_PAYMENT_STATES).toContain(project(status));
    }
  });

  it.each([
    ['partially_funded', 'PAYMENT_DETECTED'],
    ['confirming', 'CONFIRMING'],
    ['completed', 'PAID'],
    ['expired', 'EXPIRED'],
    ['canceled', 'CANCELLED'],
  ] as const)('reports %s as %s', (status, expected) => {
    expect(project(status)).toBe(expected);
  });

  /**
   * The two lossy projections, asserted explicitly so that nobody removes the compensating fields
   * from the DTO without a test failing. An overpayment is PAID and an underpayment is FAILED, and
   * in both cases the amounts are what tell the two apart.
   */
  it('reports an overpayment as PAID, because the merchant was paid', () => {
    expect(project('overpaid')).toBe('PAID');
    expect(project('completed')).toBe('PAID');
  });

  it('reports an underpayment as FAILED, because the acceptance band was never reached', () => {
    expect(project('underpaid')).toBe('FAILED');
  });

  it('separates CREATED from WAITING_FOR_PAYMENT by whether the scanner has arrived', () => {
    expect(project('pending', false)).toBe('CREATED');
    expect(project('pending', true)).toBe('WAITING_FOR_PAYMENT');
  });

  it('does not let the scanner position change any state other than pending', () => {
    const others = PAYMENT_STATUSES.filter((candidate) => candidate !== 'pending');
    for (const status of others) {
      expect(project(status, false)).toBe(project(status, true));
    }
  });
});

describe('the published transition table', () => {
  it('promises exactly the transitions in the integration contract', () => {
    const promised: readonly (readonly [PublicPaymentState, PublicPaymentState])[] = [
      ['CREATED', 'WAITING_FOR_PAYMENT'],
      ['WAITING_FOR_PAYMENT', 'PAYMENT_DETECTED'],
      ['WAITING_FOR_PAYMENT', 'EXPIRED'],
      ['WAITING_FOR_PAYMENT', 'CANCELLED'],
      ['PAYMENT_DETECTED', 'CONFIRMING'],
      ['PAYMENT_DETECTED', 'FAILED'],
      ['CONFIRMING', 'PAID'],
    ];
    for (const [from, to] of promised) {
      expect(isPublicTransitionAllowed(from, to)).toBe(true);
    }
  });

  /**
   * Edges the contract does not enumerate but the engine really takes. They are published because
   * they are real: a single transfer that pays in full skips PAYMENT_DETECTED entirely, and a reorg
   * that withdraws value walks the payment backwards. Hiding either would mean a merchant polling
   * for a state change that had already happened, or never happens at all.
   */
  it('publishes the transitions the engine takes that the contract summary omits', () => {
    expect(isPublicTransitionAllowed('WAITING_FOR_PAYMENT', 'CONFIRMING')).toBe(true);
    // A payment can be observed as CREATED and next observed as CONFIRMING: the scanner catches up
    // to the destination and credits a transfer in the same tick, so WAITING_FOR_PAYMENT is a state
    // the payment passed through without anybody being able to read it.
    expect(isPublicTransitionAllowed('CREATED', 'CONFIRMING')).toBe(true);
    expect(isPublicTransitionAllowed('CREATED', 'PAYMENT_DETECTED')).toBe(true);
    expect(isPublicTransitionAllowed('CONFIRMING', 'PAYMENT_DETECTED')).toBe(true);
    expect(isPublicTransitionAllowed('CONFIRMING', 'WAITING_FOR_PAYMENT')).toBe(true);
    expect(isPublicTransitionAllowed('PAYMENT_DETECTED', 'WAITING_FOR_PAYMENT')).toBe(true);
  });

  /** No edge leaves a terminal state. This is the property that stops a payment being credited twice. */
  it.each(PUBLIC_PAYMENT_STATES.filter((state) => isTerminalPublicState(state)))(
    'never leaves %s once it is reached',
    (terminal) => {
      expect([...ALLOWED_PUBLIC_TRANSITIONS[terminal]]).toEqual([]);
    },
  );

  it.each([
    ['CREATED', 'PAID'],
    ['WAITING_FOR_PAYMENT', 'PAID'],
    ['WAITING_FOR_PAYMENT', 'FAILED'],
    ['PAYMENT_DETECTED', 'PAID'],
    ['PAYMENT_DETECTED', 'EXPIRED'],
    ['PAYMENT_DETECTED', 'CANCELLED'],
    ['CONFIRMING', 'EXPIRED'],
    ['CONFIRMING', 'CANCELLED'],
    ['EXPIRED', 'PAID'],
    ['CANCELLED', 'PAID'],
    ['FAILED', 'PAID'],
    ['PAID', 'FAILED'],
  ] as const)('refuses %s to %s', (from, to) => {
    expect(isPublicTransitionAllowed(from, to)).toBe(false);
  });

  /**
   * Two of those refusals are worth naming. A payment that is confirming cannot expire, because
   * expiring a payment the customer has already funded because a timer fired is stealing. And a
   * payment that has been detected cannot be cancelled, because the money is already on chain.
   */
  it('refuses to expire or cancel a payment the customer has already funded', () => {
    expect(isPublicTransitionAllowed('CONFIRMING', 'EXPIRED')).toBe(false);
    expect(isPublicTransitionAllowed('PAYMENT_DETECTED', 'CANCELLED')).toBe(false);
  });

  it('enumerates all sixty-four ordered pairs and allows only the published ones', () => {
    const published = new Set(
      PUBLIC_PAYMENT_TRANSITIONS.map((transition) => `${transition.from}>${transition.to}`),
    );
    let allowed = 0;
    for (const from of PUBLIC_PAYMENT_STATES) {
      for (const to of PUBLIC_PAYMENT_STATES) {
        const isAllowed = isPublicTransitionAllowed(from, to);
        expect(isAllowed).toBe(published.has(`${from}>${to}`));
        allowed += isAllowed ? 1 : 0;
      }
    }
    expect(allowed).toBe(PUBLIC_PAYMENT_TRANSITIONS.length);
    expect(PUBLIC_PAYMENT_STATES.length ** 2).toBe(64);
  });

  it('never publishes a self-loop, which no observer could see happen', () => {
    for (const transition of PUBLIC_PAYMENT_TRANSITIONS) {
      expect(transition.from).not.toBe(transition.to);
    }
  });
});
