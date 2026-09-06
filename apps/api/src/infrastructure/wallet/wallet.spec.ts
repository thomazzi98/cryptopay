import { randomBytes } from 'node:crypto';

import { mnemonicToSeedSync } from '@scure/bip39';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AddressAllocationError,
  HierarchicalDeterministicAllocator,
} from './hierarchical-deterministic-allocator.js';
import {
  createKeyWrapperRegistry,
  createLocalKeyWrapper,
  DATA_KEY_BYTES,
  generateDataKey,
  KeyWrappingError,
  zeroBuffer,
} from './key-wrapping.js';
import { additionalDataFor, generateMasterSeed, openSeed, sealSeed } from './master-seed.js';

/**
 * The seed is the single most valuable secret in the system, and address allocation is the hottest
 * path in the product. These tests hold both to their security properties rather than only to their
 * happy paths.
 */

const KEY_ENCRYPTION_KEY = Buffer.alloc(DATA_KEY_BYTES, 7);
const OTHER_KEY = Buffer.alloc(DATA_KEY_BYTES, 9);

function wrapperWith(key: Buffer = KEY_ENCRYPTION_KEY) {
  return createLocalKeyWrapper(key, 'local-key-1');
}

function registryWith(key: Buffer = KEY_ENCRYPTION_KEY) {
  return createKeyWrapperRegistry(key, 'local-key-1');
}

const seedFor = (mnemonic: string) => Buffer.from(mnemonicToSeedSync(mnemonic));

function flipFirstBit(source: Buffer): Buffer {
  const copy = Buffer.from(source);
  copy.writeUInt8(copy.readUInt8(0) ^ 1, 0);
  return copy;
}

function flipLastBit(source: Buffer): Buffer {
  const copy = Buffer.from(source);
  const lastIndex = copy.length - 1;
  copy.writeUInt8(copy.readUInt8(lastIndex) ^ 1, lastIndex);
  return copy;
}

/**
 * The mnemonic every Ethereum development tool ships with. Its addresses are published, so this is a
 * known-answer test: it proves the derivation path and address encoding match the wider ecosystem
 * rather than merely being self-consistent.
 */
const WELL_KNOWN_MNEMONIC = 'test test test test test test test test test test test junk';
const WELL_KNOWN_ADDRESSES = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
];

describe('key wrapping', () => {
  it('round-trips a data key', () => {
    const wrapper = wrapperWith();
    const dataKey = generateDataKey();
    const additionalData = additionalDataFor('test');

    const wrapped = wrapper.wrapDataKey(dataKey, additionalData);
    expect(wrapper.unwrapDataKey(wrapped, additionalData)).toStrictEqual(dataKey);
  });

  it('rejects a key-encryption key of the wrong length', () => {
    expect(() => createLocalKeyWrapper(Buffer.alloc(16), 'short')).toThrow(KeyWrappingError);
  });

  it('produces a different wrapping every time, so two rows never look alike', () => {
    const wrapper = wrapperWith();
    const dataKey = generateDataKey();
    const additionalData = additionalDataFor('test');

    const first = wrapper.wrapDataKey(dataKey, additionalData);
    const second = wrapper.wrapDataKey(dataKey, additionalData);
    expect(first.wrappedDataKey).not.toStrictEqual(second.wrappedDataKey);
  });

  it('refuses a wrapping made under a different key', () => {
    const wrapped = wrapperWith().wrapDataKey(generateDataKey(), additionalDataFor('test'));
    expect(() => wrapperWith(OTHER_KEY).unwrapDataKey(wrapped, additionalDataFor('test'))).toThrow(
      KeyWrappingError,
    );
  });

  it('refuses a wrapping whose ciphertext has been altered', () => {
    const wrapper = wrapperWith();
    const wrapped = wrapper.wrapDataKey(generateDataKey(), additionalDataFor('test'));
    const tampered = flipLastBit(wrapped.wrappedDataKey);

    expect(() =>
      wrapper.unwrapDataKey({ ...wrapped, wrappedDataKey: tampered }, additionalDataFor('test')),
    ).toThrow(KeyWrappingError);
  });

  it('refuses a wrapping of the wrong length', () => {
    const wrapper = wrapperWith();
    const wrapped = wrapper.wrapDataKey(generateDataKey(), additionalDataFor('test'));
    expect(() =>
      wrapper.unwrapDataKey(
        { ...wrapped, wrappedDataKey: wrapped.wrappedDataKey.subarray(0, 10) },
        additionalDataFor('test'),
      ),
    ).toThrow(/unexpected length/);
  });

  // Telling an attacker which half of the guess was right makes the search cheaper.
  it('reports the same message whether the key or the additional data was wrong', () => {
    const wrapper = wrapperWith();
    const wrapped = wrapper.wrapDataKey(generateDataKey(), additionalDataFor('test'));

    const wrongKey = () => wrapperWith(OTHER_KEY).unwrapDataKey(wrapped, additionalDataFor('test'));
    const wrongData = () => wrapper.unwrapDataKey(wrapped, additionalDataFor('live'));

    expect(wrongKey).toThrow('Could not unwrap the data key');
    expect(wrongData).toThrow('Could not unwrap the data key');
  });
});

describe('sealing the master seed', () => {
  it('round-trips a seed within its environment', () => {
    const wrapper = wrapperWith();
    const seed = generateMasterSeed();
    const sealed = sealSeed(seed, 'test', wrapper);

    expect(openSeed(sealed, 'test', registryWith())).toStrictEqual(seed);
  });

  it('never stores the seed in the clear', () => {
    const seed = generateMasterSeed();
    const sealed = sealSeed(seed, 'test', wrapperWith());

    expect(sealed.ciphertext).not.toStrictEqual(seed);
    expect(sealed.ciphertext.includes(seed)).toBe(false);
  });

  /**
   * The property that makes separate seeds per environment safe. A test row copied into the live
   * slot must fail loudly, not quietly sign mainnet transactions with a testnet seed.
   */
  it('refuses to open a test envelope as live', () => {
    const sealed = sealSeed(generateMasterSeed(), 'test', wrapperWith());
    expect(() => openSeed(sealed, 'live', registryWith())).toThrow(KeyWrappingError);
  });

  it('refuses to open a live envelope as test', () => {
    const sealed = sealSeed(generateMasterSeed(), 'live', wrapperWith());
    expect(() => openSeed(sealed, 'test', registryWith())).toThrow(KeyWrappingError);
  });

  it('refuses a seed of the wrong length', () => {
    expect(() => sealSeed(randomBytes(32), 'test', wrapperWith())).toThrow(KeyWrappingError);
  });

  it('refuses an envelope under a different key-encryption key', () => {
    const sealed = sealSeed(generateMasterSeed(), 'test', wrapperWith());
    expect(() => openSeed(sealed, 'test', registryWith(OTHER_KEY))).toThrow(KeyWrappingError);
  });

  it.each(['ciphertext', 'authenticationTag', 'nonce'] as const)(
    'refuses an envelope whose %s has been altered',
    (field) => {
      const sealed = sealSeed(generateMasterSeed(), 'test', wrapperWith());
      const tampered = flipFirstBit(sealed[field]);

      expect(() => openSeed({ ...sealed, [field]: tampered }, 'test', registryWith())).toThrow(
        KeyWrappingError,
      );
    },
  );

  it('produces a different envelope each time for the same seed', () => {
    const seed = generateMasterSeed();
    const first = sealSeed(seed, 'test', wrapperWith());
    const second = sealSeed(seed, 'test', wrapperWith());
    expect(first.ciphertext).not.toStrictEqual(second.ciphertext);
  });

  it('draws a different seed every time', () => {
    const seeds = new Set(Array.from({ length: 50 }, () => generateMasterSeed().toString('hex')));
    expect(seeds.size).toBe(50);
  });
});

describe('address allocation', () => {
  // Known-answer: these are the addresses every Ethereum development tool derives from this
  // mnemonic, so matching them proves the path and encoding are the ecosystem's, not merely ours.
  it.each(WELL_KNOWN_ADDRESSES.map((account, index) => ({ index, account })))(
    'derives the published address at index $index',
    ({ index, account }) => {
      const allocator = new HierarchicalDeterministicAllocator(seedFor(WELL_KNOWN_MNEMONIC));
      expect(allocator.allocate(index).account).toBe(account);
    },
  );

  it('returns addresses already lowercased for storage', () => {
    const allocator = new HierarchicalDeterministicAllocator(seedFor(WELL_KNOWN_MNEMONIC));
    const allocated = allocator.allocate(0);
    expect(allocated.account).toBe(allocated.account.toLowerCase());
    expect(getAddress(allocated.account).toLowerCase()).toBe(allocated.account);
  });

  it('records the derivation path so a sweep can find the key again', () => {
    const allocator = new HierarchicalDeterministicAllocator(seedFor(WELL_KNOWN_MNEMONIC));
    expect(allocator.allocate(417).allocationReference).toBe("m/44'/60'/0'/0/417");
  });

  it('is deterministic for one seed', () => {
    const first = new HierarchicalDeterministicAllocator(seedFor(WELL_KNOWN_MNEMONIC));
    const second = new HierarchicalDeterministicAllocator(seedFor(WELL_KNOWN_MNEMONIC));
    expect(first.allocate(42).account).toBe(second.allocate(42).account);
  });

  it('produces unrelated addresses from a different seed', () => {
    const one = new HierarchicalDeterministicAllocator(generateMasterSeed());
    const other = new HierarchicalDeterministicAllocator(generateMasterSeed());
    expect(one.allocate(0).account).not.toBe(other.allocate(0).account);
  });

  it('issues a distinct address for every index', () => {
    const allocator = new HierarchicalDeterministicAllocator(generateMasterSeed());
    const accounts = new Set(
      Array.from({ length: 200 }, (value, index) => allocator.allocate(index).account),
    );
    expect(accounts.size).toBe(200);
  });

  it.each([-1, 1.5, 2_147_483_648, NaN])('rejects the index %s', (index) => {
    const allocator = new HierarchicalDeterministicAllocator(generateMasterSeed());
    expect(() => allocator.allocate(index)).toThrow(AddressAllocationError);
  });

  it('accepts the highest non-hardened index', () => {
    const allocator = new HierarchicalDeterministicAllocator(generateMasterSeed());
    expect(allocator.allocate(2_147_483_647).account).toMatch(/^0x[\da-f]{40}$/);
  });

  /**
   * Allocation runs on the busiest path in the product, so it must be structurally incapable of
   * signing. The allocator keeps only the account-level public key.
   */
  it('holds no private key, so the creation path cannot sign', () => {
    const allocator = new HierarchicalDeterministicAllocator(generateMasterSeed());
    const accountKey = (allocator as unknown as { accountKey: { privateKey: unknown } }).accountKey;
    expect(accountKey.privateKey).toBeNull();
  });

  it('derives children that also carry no private key', () => {
    const allocator = new HierarchicalDeterministicAllocator(generateMasterSeed());
    const accountKey = (
      allocator as unknown as {
        accountKey: { deriveChild: (index: number) => { privateKey: unknown } };
      }
    ).accountKey;
    expect(accountKey.deriveChild(0).privateKey).toBeNull();
  });
});

describe('zeroBuffer', () => {
  it('overwrites every byte', () => {
    const buffer = randomBytes(32);
    zeroBuffer(buffer);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
