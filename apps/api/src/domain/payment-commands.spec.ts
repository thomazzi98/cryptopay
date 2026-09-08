import type { PaymentStatus } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { cancelPayment, expirePayment } from './payment-commands.js';
import { createPayment, type Payment } from './payment.js';

const CREATED_AT = new Date('2026-09-06T18:00:00.000Z');
const AFTER_EXPIRY = new Date('2026-09-06T18:31:00.000Z');
const BEFORE_EXPIRY = new Date('2026-09-06T18:10:00.000Z');

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
    createdAt: CREATED_AT,
    lifetimeSeconds: 1800,
  });
  return Object.freeze({ ...payment, ...overrides });
}

describe('cancelPayment', () => {
  it('cancels a pending payment and advances the version', () => {
    const decision = cancelPayment(build(), 0);
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') {
      return;
    }
    expect(decision.payment.status).toBe('canceled');
    expect(decision.payment.statusVersion).toBe(1);
    expect(decision.events.map((event) => event.type)).toStrictEqual(['payment.canceled']);
  });

  it('reports a second cancellation as ignored rather than failed', () => {
    const decision = cancelPayment(build({ status: 'canceled' }), 0);
    expect(decision.kind).toBe('ignored');
  });

  /**
   * Cancelling a payment a customer has already funded would strand their money, so it is refused
   * for every state that can hold value.
   */
  it.each(['partially_funded', 'confirming'] as PaymentStatus[])(
    'refuses to cancel a %s payment',
    (status) => {
      const decision = cancelPayment(build({ status, creditedAmountInBaseUnits: 10_000_000n }), 0);
      expect(decision.kind).toBe('rejected');
    },
  );

  it.each(['completed', 'overpaid', 'underpaid', 'expired'] as PaymentStatus[])(
    'refuses to cancel a %s payment',
    (status) => {
      expect(cancelPayment(build({ status }), 0).kind).toBe('rejected');
    },
  );

  /**
   * The window the status cannot see. A transfer the scanner has recorded leaves the payment
   * `pending` until the evaluator runs, and cancelling in that gap sends the customer's money to an
   * address created for one invoice that nothing will look at again.
   */
  it('refuses to cancel a pending payment that already has a transfer on chain', () => {
    const decision = cancelPayment(build(), 1);
    expect(decision.kind).toBe('rejected');
    if (decision.kind !== 'rejected') {
      return;
    }
    expect(decision.reason).toContain('already received a transfer');
  });

  it('still cancels when the only transfers recorded were orphaned by a reorg', () => {
    expect(cancelPayment(build(), 0).kind).toBe('applied');
  });

  it('leaves the original payment untouched', () => {
    const payment = build();
    cancelPayment(payment, 0);
    expect(payment.status).toBe('pending');
    expect(payment.statusVersion).toBe(0);
  });
});

describe('expirePayment', () => {
  it('expires an unfunded payment once the moment has passed', () => {
    const decision = expirePayment(build(), AFTER_EXPIRY);
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') {
      return;
    }
    expect(decision.payment.status).toBe('expired');
    expect(decision.events.map((event) => event.type)).toStrictEqual(['payment.expired']);
  });

  it('underpays a partly funded payment rather than expiring it', () => {
    const decision = expirePayment(
      build({ status: 'partially_funded', creditedAmountInBaseUnits: 10_000_000n }),
      AFTER_EXPIRY,
    );
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') {
      return;
    }
    expect(decision.payment.status).toBe('underpaid');
  });

  it('does nothing before the expiry moment', () => {
    expect(expirePayment(build(), BEFORE_EXPIRY).kind).toBe('ignored');
  });

  /**
   * The rule worth stating plainly: a payment holding sufficient funds is never expired by a clock.
   * Doing so would take money the customer has already sent.
   */
  it('never expires a funded payment awaiting finality', () => {
    const decision = expirePayment(
      build({ status: 'confirming', creditedAmountInBaseUnits: 25_000_000n }),
      AFTER_EXPIRY,
    );
    expect(decision.kind).toBe('ignored');
  });

  it.each(['completed', 'overpaid', 'underpaid', 'expired', 'canceled'] as PaymentStatus[])(
    'ignores a %s payment',
    (status) => {
      expect(expirePayment(build({ status }), AFTER_EXPIRY).kind).toBe('ignored');
    },
  );

  it('advances the version exactly once', () => {
    const decision = expirePayment(build(), AFTER_EXPIRY);
    expect(decision).toMatchObject({ kind: 'applied', payment: { statusVersion: 1 } });
  });
});
