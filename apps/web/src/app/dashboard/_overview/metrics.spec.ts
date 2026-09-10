import { NATIVE_ASSET_REFERENCE } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { volumeByAsset, type OverviewPayment } from './metrics.js';

/**
 * The overview's headline volume is the one figure a merchant reads before anything else, and it is
 * a sum. What may and may not be added together is therefore a correctness question rather than a
 * presentation one.
 */

function completedPayment(
  network: OverviewPayment['network'],
  asset: { reference: string; symbol: string; decimals: number },
  creditedBaseUnits: string,
): OverviewPayment {
  return {
    identifier: `pay_${network}_${asset.symbol}_${creditedBaseUnits}`,
    status: 'completed',
    statusVersion: 3,
    environment: 'test',
    network,
    chainIdentifier: null,
    asset,
    requestedAmount: { baseUnits: creditedBaseUnits, display: '1' },
    creditedAmount: { baseUnits: creditedBaseUnits, display: '1' },
    acceptanceBand: { minimumBaseUnits: creditedBaseUnits, maximumBaseUnits: creditedBaseUnits },
    receivingAccount: '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d',
    confirmations: 12,
    requiredConfirmations: 12,
    finalityConfirmed: true,
    settlingBlockHeight: '1',
    merchantReference: null,
    callbackUrl: null,
    metadata: {},
    checkoutUrl: 'https://example.test/pay/token',
    explorerAccountUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:30:00.000Z',
    completedAt: '2026-09-01T00:10:00.000Z',
    transfers: [],
  };
}

const POL = { reference: NATIVE_ASSET_REFERENCE, symbol: 'POL', decimals: 18 };
const SOL = { reference: NATIVE_ASSET_REFERENCE, symbol: 'SOL', decimals: 9 };
const USDC_AMOY = {
  reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
  symbol: 'USDC',
  decimals: 6,
};

describe('totalling what was paid', () => {
  /**
   * Every chain's own currency carries the same sentinel reference, so a total keyed on the
   * reference alone adds POL to SOL: two different currencies, at two different scales, summed as
   * integers and then labelled with whichever symbol happened to arrive first.
   */
  it('keeps each chain native currency apart from the others', () => {
    const totals = volumeByAsset([
      completedPayment('polygon-amoy', POL, '1000000000000000000'),
      completedPayment('solana-devnet', SOL, '2000000000'),
    ]);

    expect(totals).toHaveLength(2);
    expect(
      totals.map((total) => total.symbol).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['POL', 'SOL']);
    expect(totals.find((total) => total.symbol === 'POL')?.total).toBe(1_000_000_000_000_000_000n);
    expect(totals.find((total) => total.symbol === 'SOL')?.total).toBe(2_000_000_000n);
  });

  it('adds two payments in the same asset on the same network together', () => {
    const totals = volumeByAsset([
      completedPayment('polygon-amoy', USDC_AMOY, '25000000'),
      completedPayment('polygon-amoy', USDC_AMOY, '5000000'),
    ]);

    expect(totals).toHaveLength(1);
    expect(totals[0]?.total).toBe(30_000_000n);
    expect(totals[0]?.count).toBe(2);
  });

  /** A payment that was never paid in full is not volume, whatever else it is. */
  it('counts nothing from a payment that did not succeed', () => {
    const pending = {
      ...completedPayment('polygon-amoy', USDC_AMOY, '25000000'),
      status: 'pending' as const,
    };
    expect(volumeByAsset([pending])).toEqual([]);
  });
});
