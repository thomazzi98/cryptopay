import { describe, expect, it } from 'vitest';

import {
  canonicaliseAccount,
  canonicaliseReference,
  isCanonicalAccount,
  isCanonicalReference,
  NonCanonicalAccountError,
} from './account-canonicalisation.js';

/**
 * The addresses here are real, read from the three chains rather than invented, because the whole
 * risk this module exists to remove is that a plausible-looking test value hides a case or length
 * assumption that a real address violates.
 */

const EVM_LOWERCASE = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
/**
 * Derived rather than typed. A hand-written EIP-55 literal is a lint error in this repository,
 * because an incorrect casing looks identical during review and only fails at boot. Upper-casing
 * the digits exercises the same path: any casing in, one canonical casing out.
 */
const EVM_UPPERCASE = EVM_LOWERCASE.toUpperCase().replace('0X', '0x');
const TRON_NILE_USDT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('canonicalising an EVM account', () => {
  it('accepts any casing and stores it lowercase', () => {
    expect(canonicaliseAccount('evm-lowercase-hex', EVM_UPPERCASE)).toBe(EVM_LOWERCASE);
  });

  it('is idempotent, so a stored value survives a second pass unchanged', () => {
    const once = canonicaliseAccount('evm-lowercase-hex', EVM_UPPERCASE);
    expect(canonicaliseAccount('evm-lowercase-hex', once)).toBe(once);
  });

  it('trims incidental whitespace from a pasted address', () => {
    expect(canonicaliseAccount('evm-lowercase-hex', `  ${EVM_UPPERCASE}\n`)).toBe(EVM_LOWERCASE);
  });

  /** The old rule only asserted case. This one asserts the shape too, which is strictly stronger. */
  it.each([
    ['too short', '0x3c499c542cef5e3811e1192ce70d8cc03d5c335'],
    ['too long', '0x3c499c542cef5e3811e1192ce70d8cc03d5c33590'],
    ['missing the prefix', '3c499c542cef5e3811e1192ce70d8cc03d5c3359'],
    ['not hex', '0x3c499c542cef5e3811e1192ce70d8cc03d5c335z'],
    ['a TRON address', TRON_MAINNET_USDT],
    ['empty', ''],
  ])('refuses an address that is %s', (_label, value) => {
    expect(isCanonicalAccount('evm-lowercase-hex', value)).toBe(false);
    expect(() => canonicaliseAccount('evm-lowercase-hex', value)).toThrow(NonCanonicalAccountError);
  });
});

describe('canonicalising a base58 account', () => {
  it.each([
    ['a TRON mainnet contract', TRON_MAINNET_USDT],
    ['a TRON Nile contract', TRON_NILE_USDT],
    ['a Solana mainnet mint', SOLANA_USDC_MINT],
    ['a Solana devnet mint', SOLANA_DEVNET_USDC_MINT],
  ])('passes %s through byte for byte', (_label, value) => {
    expect(canonicaliseAccount('base58-exact', value)).toBe(value);
  });

  /**
   * The failure this whole module exists to prevent. Lowercasing a base58 address does not produce
   * a different spelling of the same account, it produces an account nobody holds a key for, and
   * anything sent there is gone. Here it is refused rather than silently accepted.
   */
  it('refuses a lowercased TRON address instead of treating it as the same account', () => {
    const lowercased = TRON_MAINNET_USDT.toLowerCase();
    expect(lowercased).not.toBe(TRON_MAINNET_USDT);
    expect(isCanonicalAccount('base58-exact', lowercased)).toBe(false);
    expect(() => canonicaliseAccount('base58-exact', lowercased)).toThrow(NonCanonicalAccountError);
  });

  it('refuses the base58 characters that do not exist', () => {
    // 0, O, I and l are excluded from the alphabet precisely because they are misread.
    for (const character of ['0', 'O', 'I', 'l']) {
      const candidate = TRON_MAINNET_USDT.slice(0, -1) + character;
      expect(isCanonicalAccount('base58-exact', candidate)).toBe(false);
    }
  });

  it('refuses an EVM address, which is not base58 at all', () => {
    expect(isCanonicalAccount('base58-exact', EVM_LOWERCASE)).toBe(false);
  });

  it('refuses a string too short or too long to be an account', () => {
    expect(isCanonicalAccount('base58-exact', 'abc')).toBe(false);
    expect(isCanonicalAccount('base58-exact', 'a'.repeat(64))).toBe(false);
  });
});

describe('canonicalising a transaction reference', () => {
  const EVM_HASH = '0x570a7a56d0b465f9c4b7a84cc581da427b8460c2244326fa7262ec3c540c1b11';
  const TRON_TXID = 'f0718be7e2f71a893c06d634382554a24c862bc54ab26cdb8224deff5f629802';
  const SOLANA_SIGNATURE =
    '23XfW1pvgFCsiVNr4WHZwSpyK7grrk6Ao4wbAKK6mbHwocyAr57TdVtjQQjg4hJN7fcfdvMWaVx2obwujA1uTLyP';

  it('lowercases an EVM hash and keeps its prefix', () => {
    expect(canonicaliseReference('evm-hash', EVM_HASH.toUpperCase().replace('0X', '0x'))).toBe(
      EVM_HASH,
    );
  });

  it('accepts a bare 64-character hex TRON transaction id', () => {
    expect(canonicaliseReference('bare-hex', TRON_TXID)).toBe(TRON_TXID);
    expect(isCanonicalReference('bare-hex', EVM_HASH)).toBe(false);
  });

  it('accepts a base58 Solana signature and leaves its case alone', () => {
    expect(canonicaliseReference('base58-exact', SOLANA_SIGNATURE)).toBe(SOLANA_SIGNATURE);
    expect(isCanonicalReference('base58-exact', SOLANA_SIGNATURE.toLowerCase())).toBe(false);
  });

  it('refuses a reference of the wrong family', () => {
    expect(isCanonicalReference('evm-hash', SOLANA_SIGNATURE)).toBe(false);
    expect(isCanonicalReference('base58-exact', EVM_HASH)).toBe(false);
    expect(() => canonicaliseReference('evm-hash', TRON_TXID)).toThrow(/not a canonical/i);
  });
});
