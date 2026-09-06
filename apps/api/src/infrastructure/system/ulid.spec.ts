import { describe, expect, it } from 'vitest';

import { isPrefixedIdentifier, isUlid, ULID_LENGTH, UlidFactory } from './ulid.js';

const alphabetically = (left: string, right: string): number => left.localeCompare(right);

const FIXED_TIME = 1_757_183_400_000;

describe('UlidFactory', () => {
  it('produces a 26 character Crockford base32 identifier', () => {
    const identifier = new UlidFactory().create(FIXED_TIME);
    expect(identifier).toHaveLength(ULID_LENGTH);
    expect(isUlid(identifier)).toBe(true);
  });

  it('excludes the letters Crockford omits to avoid transcription errors', () => {
    const factory = new UlidFactory();
    const identifiers = Array.from({ length: 200 }, (value, index) =>
      factory.create(FIXED_TIME + index),
    );
    expect(identifiers.join('')).not.toMatch(/[ILOU]/);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const factory = new UlidFactory();
    const identifiers = Array.from({ length: 50 }, (value, index) =>
      factory.create(FIXED_TIME + index),
    );
    expect(identifiers).toStrictEqual([...identifiers].toSorted(alphabetically));
  });

  // Two payments created in the same tick must still sort in creation order, or cursor pagination
  // built on the identifier would return them in an arbitrary order.
  it('stays monotonic within a single millisecond', () => {
    const factory = new UlidFactory();
    const identifiers = Array.from({ length: 500 }, () => factory.create(FIXED_TIME));
    expect(identifiers).toStrictEqual([...identifiers].toSorted(alphabetically));
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  it('encodes the timestamp in the leading characters', () => {
    const factory = new UlidFactory();
    const earlier = factory.create(FIXED_TIME);
    const later = factory.create(FIXED_TIME + 60_000);
    expect(later.slice(0, 10) > earlier.slice(0, 10)).toBe(true);
  });

  it('does not repeat itself across many draws', () => {
    const factory = new UlidFactory();
    const identifiers = new Set(
      Array.from({ length: 5000 }, (value, index) => factory.create(FIXED_TIME + (index % 7))),
    );
    expect(identifiers.size).toBe(5000);
  });

  it.each([-1, 1.5, NaN, 281_474_976_710_656])('rejects the timestamp %s', (timestamp) => {
    expect(() => new UlidFactory().create(timestamp)).toThrow(RangeError);
  });
});

describe('isUlid', () => {
  it.each([
    { description: 'a lowercase identifier', candidate: '01k4qw6zr2m8x4t7yq0c3d5b9n' },
    { description: 'an excluded letter', candidate: '01K4QW6ZR2M8X4T7YQ0C3D5BIL' },
    { description: 'a truncated identifier', candidate: '01K4QW6ZR2M8X4T7YQ0C3D5B9' },
    { description: 'an over-long identifier', candidate: '01K4QW6ZR2M8X4T7YQ0C3D5B9NN' },
    { description: 'an empty string', candidate: '' },
  ])('rejects $description', ({ candidate }) => {
    expect(isUlid(candidate)).toBe(false);
  });
});

describe('isPrefixedIdentifier', () => {
  const identifier = new UlidFactory().create(FIXED_TIME);

  it('accepts the matching prefix', () => {
    expect(isPrefixedIdentifier(`pay_${identifier}`, 'pay')).toBe(true);
  });

  // Passing a webhook delivery identifier where a payment identifier belongs is a class of mistake
  // the prefix removes entirely.
  it('rejects a different prefix', () => {
    expect(isPrefixedIdentifier(`whd_${identifier}`, 'pay')).toBe(false);
  });

  it('rejects a bare identifier', () => {
    expect(isPrefixedIdentifier(identifier, 'pay')).toBe(false);
  });
});
