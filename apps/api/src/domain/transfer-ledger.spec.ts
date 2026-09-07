import type { ObservedTransfer, PaymentStatus } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { createPayment, type Payment } from './payment.js';
import {
  classifyTransfer,
  settlingBlockHeight,
  sumCreditedAmount,
  type TransferClassification,
} from './transfer-ledger.js';

/**
 * These rules decide whether money counts. Every branch is driven directly, because the cost of a
 * wrong answer here is either crediting a payment that was never made or refusing one that was.
 */

const USDC = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';
const DECOY_TOKEN = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const RECEIVING_ACCOUNT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const SOMEONE_ELSE = '0x3f9c2b7100000000000000000000000000000001';
const ALLOWED = [USDC];

function build(overrides: Partial<Payment> = {}): Payment {
  const payment = createPayment({
    identifier: 'pay_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    merchantId: 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    environment: 'test',
    networkIdentifier: 'polygon-amoy',
    checkoutToken: 'tok_abc',
    asset: { networkIdentifier: 'polygon-amoy', reference: USDC, symbol: 'USDC', decimals: 6 },
    requestedAmountInBaseUnits: 25_000_000n,
    underpaymentToleranceBasisPoints: 0,
    overpaymentToleranceBasisPoints: 0,
    receivingAccount: RECEIVING_ACCOUNT,
    requiredConfirmations: 5,
    requiresFinalityTag: true,
    createdAtBlockHeight: 46_903_000n,
    merchantReference: null,
    callbackUrl: null,
    metadata: {},
    createdAt: new Date('2026-09-06T18:00:00.000Z'),
    lifetimeSeconds: 1800,
  });
  return Object.freeze({ ...payment, ...overrides });
}

function amountEntry(
  amountInBaseUnits: bigint,
  classification: TransferClassification = 'credited',
  orphaned = false,
) {
  return { amountInBaseUnits, classification, orphaned };
}

function blockEntry(
  blockHeight: bigint,
  classification: TransferClassification = 'credited',
  orphaned = false,
) {
  return { blockHeight, classification, orphaned };
}

function transfer(overrides: Partial<ObservedTransfer> = {}): ObservedTransfer {
  return {
    reference: { transactionReference: `0x${'a'.repeat(64)}`, eventIndex: 0 },
    position: { height: 46_903_512n, reference: `0x${'b'.repeat(64)}` },
    sourceAccount: SOMEONE_ELSE,
    destinationAccount: RECEIVING_ACCOUNT,
    assetReference: USDC,
    amountInBaseUnits: 25_000_000n,
    ...overrides,
  };
}

describe('classifying a transfer', () => {
  it('credits a correct transfer to a pending payment', () => {
    const classified = classifyTransfer(build(), transfer(), ALLOWED);
    expect(classified.classification).toBe('credited');
  });

  /**
   * Bridged USDC.e returns the byte-identical symbol "USDC". If identity were the symbol, this
   * transfer would be credited and the merchant paid in a token they never agreed to accept.
   */
  it('refuses a look-alike token sent to the right address', () => {
    const classified = classifyTransfer(
      build(),
      transfer({ assetReference: DECOY_TOKEN }),
      ALLOWED,
    );
    expect(classified.classification).toBe('wrong_asset');
  });

  it('refuses an asset this network does not settle at all', () => {
    const classified = classifyTransfer(
      build(),
      transfer({ assetReference: '0x000000000000000000000000000000000000dead' }),
      ALLOWED,
    );
    expect(classified.classification).toBe('wrong_asset');
  });

  it('refuses a transfer sent to a different address', () => {
    const classified = classifyTransfer(
      build(),
      transfer({ destinationAccount: SOMEONE_ELSE }),
      ALLOWED,
    );
    expect(classified.classification).toBe('unexpected');
  });

  it.each(['pending', 'partially_funded', 'confirming'] as PaymentStatus[])(
    'credits a transfer to a %s payment',
    (status) => {
      const classified = classifyTransfer(build({ status }), transfer(), ALLOWED);
      expect(classified.classification).toBe('credited');
    },
  );

  /**
   * A late transfer is recorded, never applied. Reviving a finished payment is the edge that
   * double-credits a merchant, and a customer whose money arrived late still needs it visible.
   */
  it.each(['expired', 'underpaid'] as PaymentStatus[])(
    'records a transfer to a %s payment as late',
    (status) => {
      const classified = classifyTransfer(build({ status }), transfer(), ALLOWED);
      expect(classified.classification).toBe('late');
    },
  );

  it.each(['completed', 'overpaid', 'canceled'] as PaymentStatus[])(
    'records a transfer to a %s payment as unexpected',
    (status) => {
      const classified = classifyTransfer(build({ status }), transfer(), ALLOWED);
      expect(classified.classification).toBe('unexpected');
    },
  );

  it('explains every refusal, so support can answer a customer', () => {
    const refusals = [
      classifyTransfer(build(), transfer({ assetReference: DECOY_TOKEN }), ALLOWED),
      classifyTransfer(build(), transfer({ destinationAccount: SOMEONE_ELSE }), ALLOWED),
      classifyTransfer(build({ status: 'expired' }), transfer(), ALLOWED),
    ];
    for (const refusal of refusals) {
      expect(refusal.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('summing the credited amount', () => {
  it('is zero with nothing recorded', () => {
    expect(sumCreditedAmount([])).toBe(0n);
  });

  it('adds several credited transfers, which is how a split payment works', () => {
    expect(sumCreditedAmount([amountEntry(10_000_000n), amountEntry(15_000_000n)])).toBe(
      25_000_000n,
    );
  });

  it('excludes a transfer withdrawn by a reorg', () => {
    expect(
      sumCreditedAmount([amountEntry(10_000_000n), amountEntry(15_000_000n, 'credited', true)]),
    ).toBe(10_000_000n);
  });

  it.each(['late', 'unexpected', 'wrong_asset'] as TransferClassification[])(
    'excludes a %s transfer',
    (classification) => {
      expect(sumCreditedAmount([amountEntry(10_000_000n), amountEntry(99n, classification)])).toBe(
        10_000_000n,
      );
    },
  );

  /**
   * Recomputing rather than incrementing is what makes a replayed event harmless: the same set of
   * rows always produces the same total, however many times it is summed.
   */
  it('produces the same total however often it is recomputed', () => {
    const rows = [amountEntry(10_000_000n), amountEntry(15_000_000n), amountEntry(1n, 'late')];
    expect(sumCreditedAmount(rows)).toBe(sumCreditedAmount(rows));
  });

  it('handles an amount far beyond a 64-bit integer', () => {
    expect(sumCreditedAmount([amountEntry(10n ** 30n), amountEntry(1n)])).toBe(10n ** 30n + 1n);
  });
});

describe('choosing the settling block', () => {
  it('is unknown while nothing is credited', () => {
    expect(settlingBlockHeight([])).toBeNull();
    expect(settlingBlockHeight([blockEntry(100n, 'late')])).toBeNull();
  });

  /**
   * The highest block, not the first. Counting confirmations from the first piece of a split
   * payment would complete it while the last piece was still one block deep.
   */
  it('takes the highest block holding credited value', () => {
    expect(settlingBlockHeight([blockEntry(100n), blockEntry(140n), blockEntry(120n)])).toBe(140n);
  });

  it('ignores an orphaned transfer when choosing the block', () => {
    expect(settlingBlockHeight([blockEntry(100n), blockEntry(140n, 'credited', true)])).toBe(100n);
  });

  it('falls back to unknown when every credited transfer is orphaned', () => {
    expect(settlingBlockHeight([blockEntry(140n, 'credited', true)])).toBeNull();
  });
});
