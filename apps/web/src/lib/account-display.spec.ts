import { describe, expect, it } from 'vitest';

import { describeAsset, toDisplayAccount, walletPanelApplies } from './account-display';

/**
 * The six combinations a customer can be shown, asserted against the exact values the checkout
 * endpoint serves for each.
 *
 * These are regression tests for a page that crashed. The checkout called viem's `getAddress` on
 * every account and asset reference, which throws on anything that is not forty hex digits, so the
 * server component threw for TRON and Solana and the wallet panel threw for those plus every native
 * payment on every family. Only Polygon USDC rendered.
 */

const POLYGON_ACCOUNT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const POLYGON_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const TRON_ACCOUNT = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA_ACCOUNT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NATIVE = 'native';

describe('showing an account', () => {
  it('checksums an EVM address, because mixed case there is a checksum', () => {
    const shown = toDisplayAccount(POLYGON_ACCOUNT);

    expect(shown.toLowerCase()).toBe(POLYGON_ACCOUNT);
    expect(shown).not.toBe(POLYGON_ACCOUNT);
  });

  /**
   * The failure this module exists to prevent. Base58 is case significant, so altering it produces
   * a different address that nobody holds a key for, and the previous implementation did not alter
   * it but threw outright.
   */
  it.each([
    ['a TRON address', TRON_ACCOUNT],
    ['a Solana address', SOLANA_ACCOUNT],
    ['a TRON contract', TRON_USDT],
    ['a Solana mint', SOLANA_USDC],
  ])('passes %s through byte for byte', (_label, account) => {
    expect(toDisplayAccount(account)).toBe(account);
  });

  it.each([
    ['the native sentinel', NATIVE],
    ['an empty string', ''],
    ['something that is not an address at all', 'not-an-address'],
  ])('returns %s rather than throwing', (_label, value) => {
    expect(() => toDisplayAccount(value)).not.toThrow();
    expect(toDisplayAccount(value)).toBe(value);
  });
});

describe('describing what is being paid', () => {
  it.each([
    ['Polygon', 'POL'],
    ['TRON', 'TRX'],
    ['Solana', 'SOL'],
  ])('names the currency rather than a contract for native %s', (_label, symbol) => {
    const described = describeAsset(NATIVE, symbol);

    expect(described.isNative).toBe(true);
    expect(described.label).toContain(symbol);
    expect(described.label).not.toContain('token');
  });

  it.each([
    ['Polygon USDC', POLYGON_USDC, 'USDC'],
    ['TRON USDT', TRON_USDT, 'USDT'],
    ['Solana USDC', SOLANA_USDC, 'USDC'],
  ])('names the contract for %s', (_label, reference, symbol) => {
    const described = describeAsset(reference, symbol);

    expect(described.isNative).toBe(false);
    expect(described.label).toContain(toDisplayAccount(reference));
  });

  it('never throws for any supported combination', () => {
    const combinations: readonly (readonly [string, string])[] = [
      [NATIVE, 'POL'],
      [POLYGON_USDC, 'USDC'],
      [NATIVE, 'TRX'],
      [TRON_USDT, 'USDT'],
      [NATIVE, 'SOL'],
      [SOLANA_USDC, 'USDC'],
    ];

    for (const [reference, symbol] of combinations) {
      expect(() => describeAsset(reference, symbol)).not.toThrow();
    }
  });
});

describe('offering a browser wallet', () => {
  it('offers it for an EVM token payment, which is the only thing the panel can build', () => {
    expect(walletPanelApplies('polygon', POLYGON_USDC)).toBe(true);
  });

  it.each([
    [
      'a native EVM payment, which is a value transfer this panel does not build',
      'polygon',
      NATIVE,
    ],
    ['a TRON token payment', 'tron', TRON_USDT],
    ['a native TRON payment', 'tron', NATIVE],
    ['a Solana token payment', 'solana', SOLANA_USDC],
    ['a native Solana payment', 'solana', NATIVE],
  ])('withholds it for %s', (_label, family, reference) => {
    expect(walletPanelApplies(family, reference)).toBe(false);
  });
});
