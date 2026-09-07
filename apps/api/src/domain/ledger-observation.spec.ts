import type { PaymentStatus } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { applyLedgerObservation, type LedgerObservation } from './ledger-observation.js';
import { createPayment, type Payment } from './payment.js';

/**
 * The rule that decides a payment's status from the money credited to it.
 *
 * Every branch is driven directly, because each one is a way to get money wrong: completing a
 * payment that was underfunded, refusing one that was funded, or moving a payment that was already
 * finished and paying a merchant twice for it.
 */

const NOW = new Date('2026-09-07T12:00:00.000Z');
const SETTLING_HEIGHT = 46_903_512n;

function build(overrides: Partial<Payment> = {}): Payment {
  const payment = createPayment({
    identifier: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    merchantId: 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    environment: 'test',
    networkIdentifier: 'polygon-amoy',
    checkoutToken: 'tok_abc',
    asset: {
      networkIdentifier: 'polygon-amoy',
      reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
      symbol: 'USDC',
      decimals: 6,
    },
    requestedAmountInBaseUnits: 25_000_000n,
    underpaymentToleranceBasisPoints: 0,
    overpaymentToleranceBasisPoints: 0,
    receivingAccount: '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d',
    requiredConfirmations: 5,
    requiresFinalityTag: true,
    createdAtBlockHeight: 46_903_000n,
    merchantReference: null,
    callbackUrl: null,
    metadata: {},
    createdAt: new Date('2026-09-07T11:30:00.000Z'),
    lifetimeSeconds: 1800,
  });
  return Object.freeze({ ...payment, ...overrides });
}

function observe(overrides: Partial<LedgerObservation> = {}): LedgerObservation {
  return {
    creditedAmountInBaseUnits: 25_000_000n,
    settlingBlockHeight: SETTLING_HEIGHT,
    confirmations: 5,
    finalityIsOpen: false,
    ...overrides,
  };
}

describe('crediting money to a pending payment', () => {
  it('moves a fully funded payment to confirming, never straight to completed', () => {
    const applied = applyLedgerObservation(build(), observe({ finalityIsOpen: true }), NOW);
    expect(applied).toMatchObject({ kind: 'transitioned' });
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('confirming');
  });

  it('moves a partly funded payment to partially_funded', () => {
    const applied = applyLedgerObservation(
      build(),
      observe({ creditedAmountInBaseUnits: 10_000_000n }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('partially_funded');
  });

  it('records the credit as a credit rather than as chain progress', () => {
    const applied = applyLedgerObservation(build(), observe(), NOW);
    expect(applied.kind === 'transitioned' && applied.trigger).toBe('TRANSFER_CREDITED');
  });

  it('leaves a pending payment alone while nothing is credited', () => {
    const applied = applyLedgerObservation(
      build(),
      observe({ creditedAmountInBaseUnits: 0n, settlingBlockHeight: null, confirmations: 0 }),
      NOW,
    );
    expect(applied.kind).toBe('unchanged');
  });
});

describe('opening the finality gate', () => {
  it('completes a confirming payment once the gate opens', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming' }),
      observe({ finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('completed');
  });

  it('stamps the completion time, because the merchant reconciles on it', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming' }),
      observe({ finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.completedAt).toEqual(NOW);
  });

  /**
   * The single most expensive mistake available here. A payment completed before finality is money
   * the merchant has been told is theirs and that a reorg can still take back.
   */
  it('holds a confirming payment while the gate is shut', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming' }),
      observe({ finalityIsOpen: false, confirmations: 900 }),
      NOW,
    );
    expect(applied.kind).not.toBe('transitioned');
  });

  it('separates an overpayment from a completion', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming' }),
      observe({ creditedAmountInBaseUnits: 30_000_000n, finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('overpaid');
  });

  it('bumps the version exactly once per transition, which is what the audit trail keys on', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', statusVersion: 3 }),
      observe({ finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.statusVersion).toBe(4);
  });
});

describe('advancing the figures without changing the status', () => {
  /**
   * A confirmation count advances on nearly every tick. Reporting these as transitions would write
   * hundreds of audit rows per payment and bury the four that matter.
   */
  it('reports a rising confirmation count as progress, not as a transition', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', confirmationsObserved: 2 }),
      observe({ confirmations: 3 }),
      NOW,
    );
    expect(applied).toMatchObject({ kind: 'progressed' });
    expect(applied.kind === 'progressed' && applied.payment.confirmationsObserved).toBe(3);
  });

  it('does not bump the version for progress, so a concurrent transition still wins', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', statusVersion: 7, confirmationsObserved: 2 }),
      observe({ confirmations: 3 }),
      NOW,
    );
    expect(applied.kind === 'progressed' && applied.payment.statusVersion).toBe(7);
  });

  it('reports nothing at all when a re-evaluation finds the same figures', () => {
    const payment = build({
      status: 'confirming',
      confirmationsObserved: 5,
      creditedAmountInBaseUnits: 25_000_000n,
      settlingBlockHeight: SETTLING_HEIGHT,
    });
    expect(applyLedgerObservation(payment, observe(), NOW).kind).toBe('unchanged');
  });

  /** The property that makes an at-least-once pipeline safe: applying twice changes nothing twice. */
  it('is idempotent when applied to its own result', () => {
    const first = applyLedgerObservation(build(), observe(), NOW);
    expect(first.kind).toBe('transitioned');
    if (first.kind !== 'transitioned') {
      return;
    }
    expect(applyLedgerObservation(first.payment, observe(), NOW).kind).toBe('unchanged');
  });
});

describe('withdrawing money a reorg took back', () => {
  it('falls back to pending when every credited transfer is orphaned', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', creditedAmountInBaseUnits: 25_000_000n }),
      observe({ creditedAmountInBaseUnits: 0n, settlingBlockHeight: null, confirmations: 0 }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('pending');
  });

  it('falls back to partially_funded when a reorg leaves value below the band', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', creditedAmountInBaseUnits: 25_000_000n }),
      observe({ creditedAmountInBaseUnits: 9_000_000n }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('partially_funded');
  });

  it('records a fallback as an orphaning rather than as a credit', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming', creditedAmountInBaseUnits: 25_000_000n }),
      observe({ creditedAmountInBaseUnits: 9_000_000n }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.trigger).toBe('TRANSFERS_ORPHANED');
  });
});

describe('refusing to move a finished payment', () => {
  /**
   * There is deliberately no edge out of a terminal status. A resurrection edge is precisely what
   * double-credits a merchant, and a late transfer is recorded and shown instead of being applied.
   */
  it.each(['completed', 'overpaid', 'underpaid', 'expired', 'canceled'] as PaymentStatus[])(
    'leaves a %s payment exactly as it is',
    (status) => {
      const applied = applyLedgerObservation(
        build({ status }),
        observe({ creditedAmountInBaseUnits: 99_000_000n, finalityIsOpen: true }),
        NOW,
      );
      expect(applied).toMatchObject({ kind: 'unchanged' });
    },
  );

  it('says which status it refused for, so an operator can tell why', () => {
    const applied = applyLedgerObservation(build({ status: 'expired' }), observe(), NOW);
    expect(applied.kind === 'unchanged' && applied.reason).toContain('expired');
  });
});

describe('tolerances', () => {
  it('accepts a payment inside the underpayment tolerance', () => {
    const tolerant = build({
      acceptanceBand: { minimumInBaseUnits: 24_750_000n, maximumInBaseUnits: 25_000_000n },
      status: 'confirming',
    });
    const applied = applyLedgerObservation(
      tolerant,
      observe({ creditedAmountInBaseUnits: 24_800_000n, finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('completed');
  });

  it('treats a payment one base unit short as underfunded, not as close enough', () => {
    const applied = applyLedgerObservation(
      build({ status: 'confirming' }),
      observe({ creditedAmountInBaseUnits: 24_999_999n, finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('partially_funded');
  });

  it('accepts an overpayment inside the tolerance as a completion', () => {
    const tolerant = build({
      acceptanceBand: { minimumInBaseUnits: 25_000_000n, maximumInBaseUnits: 25_250_000n },
      status: 'confirming',
    });
    const applied = applyLedgerObservation(
      tolerant,
      observe({ creditedAmountInBaseUnits: 25_100_000n, finalityIsOpen: true }),
      NOW,
    );
    expect(applied.kind === 'transitioned' && applied.payment.status).toBe('completed');
  });
});
