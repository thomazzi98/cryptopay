import { describe, expect, it } from 'vitest';

import { USDC_DECIMALS } from './chain-constants.js';
import type { AssetDescriptor } from './ledger-primitives.js';
import {
  calculateAcceptanceBand,
  createMoney,
  formatBaseUnits,
  formatMoney,
  InvalidAmountError,
  parseAmountToBaseUnits,
} from './money.js';

const USDC: AssetDescriptor = Object.freeze({
  networkIdentifier: 'polygon-amoy',
  reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
  symbol: 'USDC',
  decimals: USDC_DECIMALS,
});

describe('parseAmountToBaseUnits', () => {
  it.each([
    ['1', 1_000_000n],
    ['0', 0n],
    ['0.000001', 1n],
    ['10', 10_000_000n],
    ['25.5', 25_500_000n],
    ['25.000000', 25_000_000n],
    ['1234567.891234', 1_234_567_891_234n],
  ])('reads %s USDC as %s base units', (display, expected) => {
    expect(parseAmountToBaseUnits(display, USDC_DECIMALS)).toBe(expected);
  });

  it('does not lose precision on an amount far beyond Number.MAX_SAFE_INTEGER', () => {
    const display = '1000000000000000000000000.123456';
    expect(parseAmountToBaseUnits(display, USDC_DECIMALS)).toBe(
      1_000_000_000_000_000_000_000_000_123_456n,
    );
  });

  it('rejects rather than rounds when precision exceeds the asset', () => {
    expect(() => parseAmountToBaseUnits('1.0000005', USDC_DECIMALS)).toThrow(InvalidAmountError);
  });

  it.each([
    { description: 'a negative amount', candidate: '-1' },
    { description: 'exponent notation', candidate: '1e6' },
    { description: 'thousands separators', candidate: '1,000' },
    { description: 'a bare decimal point', candidate: '.' },
    { description: 'a trailing decimal point', candidate: '1.' },
    { description: 'a leading decimal point', candidate: '.5' },
    { description: 'a hex string', candidate: '0x10' },
    { description: 'empty input', candidate: '' },
    { description: 'not a number', candidate: 'abc' },
    { description: 'infinity', candidate: 'Infinity' },
  ])('rejects $description', ({ candidate }) => {
    expect(() => parseAmountToBaseUnits(candidate, USDC_DECIMALS)).toThrow(InvalidAmountError);
  });

  it('accepts a zero-decimal asset only as a whole number', () => {
    expect(parseAmountToBaseUnits('7', 0)).toBe(7n);
    expect(() => parseAmountToBaseUnits('7.1', 0)).toThrow(InvalidAmountError);
  });

  it('handles an eighteen-decimal asset without touching floating point', () => {
    expect(parseAmountToBaseUnits('0.1', 18)).toBe(100_000_000_000_000_000n);
  });
});

describe('formatBaseUnits', () => {
  it.each([
    [1_000_000n, '1.000000'],
    [0n, '0.000000'],
    [1n, '0.000001'],
    [25_500_000n, '25.500000'],
    [999_999n, '0.999999'],
  ])('renders %s base units as %s', (baseUnits, expected) => {
    expect(formatBaseUnits(baseUnits, USDC_DECIMALS)).toBe(expected);
  });

  it('renders a zero-decimal asset without a decimal point', () => {
    expect(formatBaseUnits(7n, 0)).toBe('7');
  });

  it('rejects a negative amount', () => {
    expect(() => formatBaseUnits(-1n, USDC_DECIMALS)).toThrow(InvalidAmountError);
  });
});

describe('parse and format round-trip', () => {
  it.each(['0.000000', '1.000000', '25.500000', '999999999.999999', '0.000001'])(
    'preserves %s exactly',
    (display) => {
      expect(formatBaseUnits(parseAmountToBaseUnits(display, USDC_DECIMALS), USDC_DECIMALS)).toBe(
        display,
      );
    },
  );

  it('preserves a 10^30-scale amount, which no JSON number could carry', () => {
    const baseUnits = 10n ** 30n;
    expect(parseAmountToBaseUnits(formatBaseUnits(baseUnits, USDC_DECIMALS), USDC_DECIMALS)).toBe(
      baseUnits,
    );
  });
});

describe('createMoney', () => {
  it('rejects a negative amount', () => {
    expect(() => createMoney(-1n, USDC)).toThrow(InvalidAmountError);
  });

  it('formats through its own asset decimals', () => {
    expect(formatMoney(createMoney(25_000_000n, USDC))).toBe('25.000000');
  });

  it('is frozen, so an amount cannot be mutated after construction', () => {
    expect(Object.isFrozen(createMoney(1n, USDC))).toBe(true);
  });
});

describe('calculateAcceptanceBand', () => {
  it('is exact when both tolerances are zero', () => {
    const band = calculateAcceptanceBand(25_000_000n, 0, 0);
    expect(band.minimumInBaseUnits).toBe(25_000_000n);
    expect(band.maximumInBaseUnits).toBe(25_000_000n);
  });

  it('widens by the requested basis points', () => {
    const band = calculateAcceptanceBand(10_000_000n, 100, 50);
    expect(band.minimumInBaseUnits).toBe(9_900_000n);
    expect(band.maximumInBaseUnits).toBe(10_050_000n);
  });

  it('floors the allowance rather than rounding up, so it never over-accepts', () => {
    const band = calculateAcceptanceBand(999n, 1, 1);
    expect(band.minimumInBaseUnits).toBe(999n);
    expect(band.maximumInBaseUnits).toBe(999n);
  });

  it('rejects a non-positive requested amount', () => {
    expect(() => calculateAcceptanceBand(0n, 0, 0)).toThrow(InvalidAmountError);
  });

  it('rejects negative tolerances', () => {
    expect(() => calculateAcceptanceBand(1000n, -1, 0)).toThrow(InvalidAmountError);
  });

  it('rejects an underpayment tolerance that would accept nothing', () => {
    expect(() => calculateAcceptanceBand(1000n, 10_001, 0)).toThrow(InvalidAmountError);
  });
});
