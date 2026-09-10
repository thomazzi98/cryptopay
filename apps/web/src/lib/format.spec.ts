import { describe, expect, it } from 'vitest';

import { formatAmount, formatExactAmount, truncateReference } from './format.js';

/**
 * How a figure is written is not cosmetic here: the dashboard's headline volume, every table row and
 * the checkout's balance lines all read through these, and a number that rounds to nothing tells a
 * merchant that nothing arrived.
 */
describe('formatting an amount for reading', () => {
  it('groups thousands and keeps two places for an amount that has them', () => {
    expect(formatAmount('1234567.891')).toBe('1,234,567.89');
    expect(formatAmount('25.000000')).toBe('25.00');
  });

  /**
   * The case two decimal places was chosen for. A six-decimal stablecoin never reaches it; an
   * eighteen-decimal currency reaches it on a perfectly ordinary payment.
   */
  it('never writes a non-zero amount as zero', () => {
    expect(formatAmount('0.004')).toBe('0.004');
    expect(formatAmount('0.000000000000000001')).toBe('0.000000000000000001');
  });

  it('still writes an amount that really is zero as zero', () => {
    expect(formatAmount('0.00')).toBe('0.00');
    expect(formatAmount('0')).toBe('0');
  });

  /** A leading zero is only significant when nothing before it is. */
  it('does not extend an amount whose whole part already carries the value', () => {
    expect(formatAmount('12.0004')).toBe('12.00');
  });

  it('leaves the exact figure exact, because a details row is where the real value belongs', () => {
    expect(formatExactAmount('1234.567890')).toBe('1,234.567890');
    expect(formatExactAmount('0.000000000000000001')).toBe('0.000000000000000001');
  });
});

describe('shortening a reference', () => {
  /** Both ends are kept because both ends are what someone compares against a block explorer. */
  it('keeps both ends of a value long enough to need shortening', () => {
    expect(truncateReference(`0x${'a'.repeat(64)}`)).toBe('0xaaaa…aaaa');
    expect(truncateReference('0xabc')).toBe('0xabc');
  });
});
