import { describe, expect, it } from 'vitest';

import {
  decodeTronAddress,
  encodeTronAddress,
  InvalidTronAddressError,
  isTronAddress,
  tronAddressFromLogValue,
} from './address.js';

/**
 * Every value here was read from the TRON Nile network, not invented, because the failure this
 * module exists to prevent is a conversion that produces a well-formed address belonging to nobody.
 * An invented fixture would have agreed with whatever the code did.
 */

const MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MAINNET_USDT_PAYLOAD = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const NILE_USDT = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const NILE_USDT_PAYLOAD = '41ea51342dabbb928ae1e576bd39eff8aaf070a8c6';
const NILE_TEST_TOKEN = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

describe('reading a TRON address', () => {
  it.each([
    [MAINNET_USDT, MAINNET_USDT_PAYLOAD],
    [NILE_USDT, NILE_USDT_PAYLOAD],
  ])('decodes %s to its 21 byte payload', (address, payload) => {
    expect(decodeTronAddress(address)).toBe(payload);
  });

  it.each([MAINNET_USDT, NILE_USDT, NILE_TEST_TOKEN])('round trips %s exactly', (address) => {
    expect(encodeTronAddress(decodeTronAddress(address))).toBe(address);
  });

  it('rejects an address whose checksum was altered by one character', () => {
    const tampered = `${MAINNET_USDT.slice(0, -1)}u`;
    expect(() => decodeTronAddress(tampered)).toThrow(/checksum/);
    expect(isTronAddress(tampered)).toBe(false);
  });

  /**
   * Base58 has no `0`, `O`, `I` or `l`, which is why a lowercased TRON address is not a quieter
   * spelling of the same account: it is not an address at all, and it fails here rather than in a
   * scan that silently matches nothing.
   */
  it('rejects a lowercased address rather than treating it as the same account', () => {
    expect(isTronAddress(MAINNET_USDT.toLowerCase())).toBe(false);
  });

  it('rejects an EVM address', () => {
    expect(isTronAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')).toBe(false);
  });

  it('rejects a payload that does not begin with the TRON prefix', () => {
    expect(() => encodeTronAddress(`00${MAINNET_USDT_PAYLOAD.slice(2)}`)).toThrow(
      InvalidTronAddressError,
    );
  });

  it('rejects a payload of the wrong length', () => {
    expect(() => encodeTronAddress('41abcd')).toThrow(/21 byte payload/);
  });
});

/**
 * The conversion that decides whether a TRC-20 payment is credited or lost. TronGrid returns log
 * values as bare hex with no `0x41`, so the twenty bytes below are what a Transfer event carries and
 * the base58 addresses are what the account-indexed API reports for the very same transfer.
 */
describe('turning an event log value into an address', () => {
  const LOG_CONTRACT = 'eca9bc828a3005b9a3b909f2cc5c2a54794de05f';
  const LOG_RECIPIENT_KEY_HASH = 'ea51342dabbb928ae1e576bd39eff8aaf070a8c6';
  // A topic is a thirty-two byte slot, so a twenty byte address arrives left padded. Built here
  // rather than written out, so the padding is visible as the reason the value is that long.
  const LOG_RECIPIENT_TOPIC = LOG_RECIPIENT_KEY_HASH.padStart(64, '0');

  it('recovers the recipient from a 32 byte padded topic', () => {
    expect(tronAddressFromLogValue(LOG_RECIPIENT_TOPIC)).toBe(NILE_USDT);
  });

  it('recovers the contract from a 20 byte log address', () => {
    expect(tronAddressFromLogValue(LOG_CONTRACT)).toBe(NILE_TEST_TOKEN);
  });

  /**
   * The whole point, stated as an assertion. Reading the same twenty bytes as an EVM address
   * produces a different identity, and a payment matched against it would never be credited.
   */
  it('does not produce the address an EVM reading of the same bytes would', () => {
    const asTron = tronAddressFromLogValue(LOG_CONTRACT);
    expect(asTron).not.toContain(LOG_CONTRACT);
    expect(asTron.startsWith('T')).toBe(true);
    expect(decodeTronAddress(asTron)).toBe(`41${LOG_CONTRACT}`);
  });

  it('accepts the 0x prefix TronGrid sometimes includes', () => {
    expect(tronAddressFromLogValue(`0x${LOG_CONTRACT}`)).toBe(NILE_TEST_TOKEN);
  });

  it('refuses a value that is not an address length', () => {
    expect(() => tronAddressFromLogValue('abcd')).toThrow(/20 or 32 bytes/);
  });
});
