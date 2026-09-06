import type { AssetDescriptor } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import {
  confirmationsFor,
  createPayment,
  exceedsAcceptanceBand,
  hasExpired,
  isFinished,
  reachesAcceptanceBand,
  type CreatePaymentInput,
  type Payment,
} from './payment.js';

const CREATED_AT = new Date('2026-09-06T18:00:00.000Z');

const USDC: AssetDescriptor = Object.freeze({
  networkIdentifier: 'polygon-amoy',
  reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
  symbol: 'USDC',
  decimals: 6,
});

function build(overrides: Partial<CreatePaymentInput> = {}): Payment {
  return createPayment({
    identifier: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    merchantId: 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    environment: 'test',
    networkIdentifier: 'polygon-amoy',
    checkoutToken: 'tok_abc',
    asset: USDC,
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
    ...overrides,
  });
}

function withCredited(amount: bigint): Payment {
  return Object.freeze({ ...build(), creditedAmountInBaseUnits: amount });
}

describe('createPayment', () => {
  it('starts pending with nothing credited', () => {
    const payment = build();
    expect(payment.status).toBe('pending');
    expect(payment.statusVersion).toBe(0);
    expect(payment.creditedAmountInBaseUnits).toBe(0n);
    expect(payment.completedAt).toBeNull();
  });

  it('is frozen, so no caller can mutate it in place', () => {
    expect(Object.isFrozen(build())).toBe(true);
  });

  it('sets expiry from the creation time and the lifetime', () => {
    const payment = build({ lifetimeSeconds: 900 });
    expect(payment.expiresAt.toISOString()).toBe('2026-09-06T18:15:00.000Z');
  });

  it('makes the acceptance band exact when tolerances are zero', () => {
    const payment = build();
    expect(payment.acceptanceBand.minimumInBaseUnits).toBe(25_000_000n);
    expect(payment.acceptanceBand.maximumInBaseUnits).toBe(25_000_000n);
  });

  it('widens the band by the merchant tolerances', () => {
    const payment = build({
      underpaymentToleranceBasisPoints: 100,
      overpaymentToleranceBasisPoints: 50,
    });
    expect(payment.acceptanceBand.minimumInBaseUnits).toBe(24_750_000n);
    expect(payment.acceptanceBand.maximumInBaseUnits).toBe(25_125_000n);
  });

  it('snapshots the confirmation policy, so changing it later cannot move a live payment', () => {
    const payment = build({ requiredConfirmations: 12, requiresFinalityTag: false });
    expect(payment.requiredConfirmations).toBe(12);
    expect(payment.requiresFinalityTag).toBe(false);
  });

  it('copies metadata rather than holding the caller reference', () => {
    const metadata = { orderId: 'order-1' };
    const payment = build({ metadata });
    metadata.orderId = 'changed';
    expect(payment.metadata.orderId).toBe('order-1');
  });

  it('records the block height a cold start rewinds to', () => {
    expect(build().createdAtBlockHeight).toBe(46_903_000n);
  });
});

describe('hasExpired', () => {
  it('is false before the expiry moment', () => {
    const payment = build({ lifetimeSeconds: 60 });
    expect(hasExpired(payment, new Date('2026-09-06T18:00:59.999Z'))).toBe(false);
  });

  it('is true at the expiry moment', () => {
    const payment = build({ lifetimeSeconds: 60 });
    expect(hasExpired(payment, new Date('2026-09-06T18:01:00.000Z'))).toBe(true);
  });
});

describe('the acceptance band', () => {
  it('is not reached below the minimum', () => {
    expect(reachesAcceptanceBand(withCredited(24_999_999n))).toBe(false);
  });

  it('is reached exactly at the minimum', () => {
    expect(reachesAcceptanceBand(withCredited(25_000_000n))).toBe(true);
  });

  it('is not exceeded at the maximum', () => {
    expect(exceedsAcceptanceBand(withCredited(25_000_000n))).toBe(false);
  });

  it('is exceeded one unit above the maximum', () => {
    expect(exceedsAcceptanceBand(withCredited(25_000_001n))).toBe(true);
  });

  it('treats nothing credited as not reached', () => {
    expect(reachesAcceptanceBand(build())).toBe(false);
  });
});

describe('confirmationsFor', () => {
  it('is zero while no settling block is known', () => {
    expect(confirmationsFor(build(), 46_903_512n)).toBe(0);
  });

  // The settling block itself counts as the first confirmation, which is the convention every
  // explorer uses; being off by one here would complete payments a block early.
  it('counts the settling block as the first confirmation', () => {
    const payment = Object.freeze({ ...build(), settlingBlockHeight: 46_903_512n });
    expect(confirmationsFor(payment, 46_903_512n)).toBe(1);
    expect(confirmationsFor(payment, 46_903_516n)).toBe(5);
  });

  // A reorg can leave the tip below a height that was previously observed. Reporting a negative
  // count would flow into the progress bar and into comparisons against the requirement.
  it('never reports a negative count when the tip is behind', () => {
    const payment = Object.freeze({ ...build(), settlingBlockHeight: 46_903_512n });
    expect(confirmationsFor(payment, 46_903_000n)).toBe(0);
  });
});

describe('isFinished', () => {
  it.each(['completed', 'overpaid', 'underpaid', 'expired', 'canceled'] as const)(
    'reports %s as finished',
    (status) => {
      const payment = Object.freeze({ ...build(), status });
      expect(isFinished(payment)).toBe(true);
    },
  );

  it.each(['pending', 'partially_funded', 'confirming'] as const)(
    'reports %s as unfinished',
    (status) => {
      const payment = Object.freeze({ ...build(), status });
      expect(isFinished(payment)).toBe(false);
    },
  );
});
