import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENTS,
  isEnvironment,
  isNetworkIdentifier,
  NETWORK_IDENTIFIERS,
  positionsAreEqual,
  transferReferenceKey,
  transferReferencesAreEqual,
} from './ledger-primitives.js';

describe('network identifiers', () => {
  it('lists every supported network exactly once', () => {
    expect(new Set(NETWORK_IDENTIFIERS).size).toBe(NETWORK_IDENTIFIERS.length);
    expect(NETWORK_IDENTIFIERS).toContain('polygon-mainnet');
    expect(NETWORK_IDENTIFIERS).toContain('polygon-amoy');
  });

  it('is frozen, so no adapter can register a network at runtime', () => {
    expect(Object.isFrozen(NETWORK_IDENTIFIERS)).toBe(true);
    expect(Object.isFrozen(ENVIRONMENTS)).toBe(true);
  });

  it.each(['polygon-mainnet', 'polygon-amoy', 'local-anvil'])('recognises %s', (candidate) => {
    expect(isNetworkIdentifier(candidate)).toBe(true);
  });

  it.each(['ethereum', 'POLYGON-MAINNET', 'polygon', '', 'polygon-amoy '])(
    'rejects %s',
    (candidate) => {
      expect(isNetworkIdentifier(candidate)).toBe(false);
    },
  );
});

describe('environments', () => {
  it('recognises only live and test', () => {
    expect(isEnvironment('live')).toBe(true);
    expect(isEnvironment('test')).toBe(true);
    expect(isEnvironment('production')).toBe(false);
    expect(isEnvironment('staging')).toBe(false);
  });
});

describe('positionsAreEqual', () => {
  const position = { height: 100n, reference: '0xaaa' };

  it('matches on height and reference together', () => {
    expect(positionsAreEqual(position, { height: 100n, reference: '0xaaa' })).toBe(true);
  });

  // A replacement block at an already-seen height is exactly the reorg case that height-only
  // comparison misses.
  it('separates two different blocks at the same height', () => {
    expect(positionsAreEqual(position, { height: 100n, reference: '0xbbb' })).toBe(false);
  });

  it('separates the same block reference at different heights', () => {
    expect(positionsAreEqual(position, { height: 101n, reference: '0xaaa' })).toBe(false);
  });
});

describe('transfer references', () => {
  const reference = { transactionReference: '0xfeed', eventIndex: 3 };

  it('treats two events in one transaction as distinct transfers', () => {
    expect(
      transferReferencesAreEqual(reference, { transactionReference: '0xfeed', eventIndex: 4 }),
    ).toBe(false);
  });

  it('matches an identical reference', () => {
    expect(
      transferReferencesAreEqual(reference, { transactionReference: '0xfeed', eventIndex: 3 }),
    ).toBe(true);
  });

  it('builds a stable key that separates event indices', () => {
    expect(transferReferenceKey(reference)).toBe('0xfeed:3');
    expect(transferReferenceKey({ transactionReference: '0xfeed', eventIndex: 30 })).not.toBe(
      transferReferenceKey({ transactionReference: '0xfeed', eventIndex: 3 }),
    );
  });

  it('builds the same key for the same reference every time', () => {
    expect(transferReferenceKey(reference)).toBe(transferReferenceKey({ ...reference }));
  });
});
