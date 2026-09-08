import { describe, expect, it } from 'vitest';

import { costOf, decideSpend, totalCommitted, type TreasurySpend } from './spend-ceiling.js';

/**
 * The ceiling is the only control in this system that bounds losses by amount rather than by
 * destination, so the cases that matter are the ones where it would be tempting to be optimistic:
 * transactions still in flight, and a proposal that lands exactly on the limit.
 */

const ONE_POL = 10n ** 18n;

function spend(overrides: Partial<TreasurySpend> = {}): TreasurySpend {
  return {
    valueInNativeUnits: 0n,
    maximumFeeInNativeUnits: 0n,
    feePaidInNativeUnits: null,
    ...overrides,
  };
}

describe('what a recorded transaction counts for', () => {
  it('counts the receipt once there is one', () => {
    expect(
      costOf(
        spend({
          valueInNativeUnits: 100n,
          maximumFeeInNativeUnits: 90n,
          feePaidInNativeUnits: 10n,
        }),
      ),
    ).toBe(110n);
  });

  /**
   * An unresolved transaction counts at its worst case. A ceiling that can be crossed by
   * transactions already in the mempool does not bound anything, and the mempool is exactly where
   * money is when nobody can say what it cost yet.
   */
  it('counts the worst case while the transaction is unresolved', () => {
    expect(costOf(spend({ valueInNativeUnits: 100n, maximumFeeInNativeUnits: 90n }))).toBe(190n);
  });

  it('sums an empty history to nothing', () => {
    expect(totalCommitted([])).toBe(0n);
  });

  it('sums a mixed history', () => {
    const history = [
      spend({ valueInNativeUnits: 10n, maximumFeeInNativeUnits: 5n, feePaidInNativeUnits: 3n }),
      spend({ valueInNativeUnits: 20n, maximumFeeInNativeUnits: 7n }),
    ];
    expect(totalCommitted(history)).toBe(13n + 27n);
  });
});

describe('deciding whether to sign', () => {
  it('permits a proposal that stays below the ceiling', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: ONE_POL,
      committedInNativeUnits: ONE_POL / 4n,
      proposed: { valueInNativeUnits: ONE_POL / 4n, maximumFeeInNativeUnits: 0n },
    });

    expect(decision).toStrictEqual({
      kind: 'permitted',
      committedInNativeUnits: ONE_POL / 4n,
      remainingInNativeUnits: ONE_POL / 2n,
    });
  });

  // A ceiling nobody can reach is a ceiling that was set one unit too low.
  it('permits a proposal that lands exactly on the ceiling', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: ONE_POL,
      committedInNativeUnits: ONE_POL / 2n,
      proposed: { valueInNativeUnits: ONE_POL / 2n, maximumFeeInNativeUnits: 0n },
    });

    expect(decision.kind).toBe('permitted');
  });

  it('refuses a proposal one unit above the ceiling', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: ONE_POL,
      committedInNativeUnits: ONE_POL / 2n,
      proposed: { valueInNativeUnits: ONE_POL / 2n, maximumFeeInNativeUnits: 1n },
    });

    expect(decision).toStrictEqual({
      kind: 'refused',
      committedInNativeUnits: ONE_POL / 2n,
      ceilingInNativeUnits: ONE_POL,
      wouldReachInNativeUnits: ONE_POL + 1n,
    });
  });

  it('refuses on the fee alone, not only on the value', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: 100n,
      committedInNativeUnits: 0n,
      proposed: { valueInNativeUnits: 1n, maximumFeeInNativeUnits: 100n },
    });

    expect(decision.kind).toBe('refused');
  });

  it('refuses once the history alone has reached the ceiling', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: 100n,
      committedInNativeUnits: 100n,
      proposed: { valueInNativeUnits: 0n, maximumFeeInNativeUnits: 1n },
    });

    expect(decision.kind).toBe('refused');
  });

  it('permits everything when no ceiling is configured', () => {
    const decision = decideSpend({
      ceilingInNativeUnits: null,
      committedInNativeUnits: ONE_POL * 1000n,
      proposed: { valueInNativeUnits: ONE_POL * 1000n, maximumFeeInNativeUnits: ONE_POL },
    });

    expect(decision.kind).toBe('permitted');
  });

  /**
   * The arithmetic is bigint end to end. A ceiling expressed in wei overflows a double at around
   * nine POL, and a guard that silently rounds is a guard that eventually permits the wrong thing.
   */
  it('is exact at magnitudes that would not survive a double', () => {
    const ceiling = 10n ** 24n;
    const decision = decideSpend({
      ceilingInNativeUnits: ceiling,
      committedInNativeUnits: ceiling - 1n,
      proposed: { valueInNativeUnits: 1n, maximumFeeInNativeUnits: 0n },
    });

    expect(decision).toStrictEqual({
      kind: 'permitted',
      committedInNativeUnits: ceiling - 1n,
      remainingInNativeUnits: 0n,
    });
  });
});
