import type { ChainProgress } from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import type { FinalityConfirmation } from '../application/ports/chain-gateway.port.js';
import { assessFinality, finalityHasStalled } from './finality-policy.js';
import { createPayment, type Payment } from './payment.js';

/**
 * The gate that decides when a payment is called complete. Getting it wrong in one direction pays a
 * merchant for money that can still be withdrawn by a reorg; in the other it strands a customer's
 * funds indefinitely. Every branch is driven here.
 */

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
    createdAt: new Date('2026-09-06T18:00:00.000Z'),
    lifetimeSeconds: 1800,
  });
  return Object.freeze({ ...payment, settlingBlockHeight: SETTLING_HEIGHT, ...overrides });
}

function progress(tipHeight: bigint, finalizedHeight: bigint | null): ChainProgress {
  return {
    tip: { height: tipHeight, reference: `0x${'a'.repeat(64)}` },
    finalizedHeight,
    observedAtMilliseconds: 0,
  };
}

describe('assessing finality', () => {
  it('refuses while no settling block is known', () => {
    const assessment = assessFinality(
      build({ settlingBlockHeight: null }),
      progress(SETTLING_HEIGHT + 100n, SETTLING_HEIGHT + 100n),
      'confirmed',
    );
    expect(assessment.creditable).toBe(false);
  });

  it('refuses below the required confirmation count', () => {
    const assessment = assessFinality(
      build(),
      progress(SETTLING_HEIGHT + 3n, SETTLING_HEIGHT),
      'confirmed',
    );
    expect(assessment).toMatchObject({ creditable: false, confirmations: 4 });
  });

  it('credits when both the count and the finality tag are satisfied', () => {
    const assessment = assessFinality(
      build(),
      progress(SETTLING_HEIGHT + 4n, SETTLING_HEIGHT),
      'confirmed',
    );
    expect(assessment).toMatchObject({ creditable: true, confirmations: 5 });
  });

  /**
   * Both gates, whichever is later. Enough confirmations but no finality is exactly the window a
   * reorg lives in, and a count-only gate would pay the merchant inside it.
   */
  it('refuses when confirmations are reached but the block is not finalized', () => {
    const assessment = assessFinality(
      build(),
      progress(SETTLING_HEIGHT + 50n, SETTLING_HEIGHT - 1n),
      'confirmed',
    );
    expect(assessment.creditable).toBe(false);
    expect(assessment.reason).toContain('not yet finalized');
  });

  it('refuses when the block is finalized but confirmations are short', () => {
    const assessment = assessFinality(
      build(),
      progress(SETTLING_HEIGHT + 1n, SETTLING_HEIGHT + 1n),
      'confirmed',
    );
    expect(assessment.creditable).toBe(false);
    expect(assessment.reason).toContain('confirmations');
  });

  // A provider that cannot answer must never be read as "nothing is final", nor as "everything is".
  it('refuses when the chain reports no finalized height at all', () => {
    const assessment = assessFinality(build(), progress(SETTLING_HEIGHT + 50n, null), 'confirmed');
    expect(assessment.creditable).toBe(false);
  });

  it('credits on a chain that publishes no finality tag once the count is reached', () => {
    const assessment = assessFinality(
      build({ requiresFinalityTag: false }),
      progress(SETTLING_HEIGHT + 4n, null),
      'unavailable',
    );
    expect(assessment.creditable).toBe(true);
  });

  it.each<FinalityConfirmation>(['contradicted', 'unavailable'])(
    'refuses when the second provider says %s',
    (secondOpinion) => {
      const assessment = assessFinality(
        build(),
        progress(SETTLING_HEIGHT + 50n, SETTLING_HEIGHT + 10n),
        secondOpinion,
      );
      expect(assessment.creditable).toBe(false);
    },
  );

  it('reports the confirmation count even while refusing, because the customer watches it', () => {
    const assessment = assessFinality(build(), progress(SETTLING_HEIGHT + 2n, null), 'unavailable');
    expect(assessment.confirmations).toBe(3);
  });

  it('never reports a negative count when the tip is behind after a reorg', () => {
    const assessment = assessFinality(
      build(),
      progress(SETTLING_HEIGHT - 10n, null),
      'unavailable',
    );
    expect(assessment.confirmations).toBe(0);
  });
});

describe('detecting a stalled finality view', () => {
  const observedAt = new Date('2026-09-06T18:00:00.000Z');

  it('is not stalled when finality advanced recently', () => {
    expect(finalityHasStalled(observedAt, new Date('2026-09-06T18:01:00.000Z'), 120)).toBe(false);
  });

  /**
   * A count cannot detect this: blocks keep arriving while nothing finalizes, so confirmations
   * climb past the requirement on a chain that has not settled anything.
   */
  it('is stalled once nothing has finalized for longer than the limit', () => {
    expect(finalityHasStalled(observedAt, new Date('2026-09-06T18:03:00.000Z'), 120)).toBe(true);
  });

  it('is not stalled before anything has ever finalized', () => {
    expect(finalityHasStalled(null, new Date('2026-09-06T19:00:00.000Z'), 120)).toBe(false);
  });
});
