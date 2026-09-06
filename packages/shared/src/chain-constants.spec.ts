import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  ERC20_TRANSFER_EVENT_TOPIC,
  isCanonicalAddress,
  LOCAL_ANVIL_CHAIN_IDENTIFIER,
  POLYGON_AMOY_CHAIN_IDENTIFIER,
  POLYGON_MAINNET_CHAIN_IDENTIFIER,
  toCanonicalAddress,
  USDC_BRIDGED_POLYGON_MAINNET_ADDRESS,
  USDC_DECIMALS,
  USDC_POLYGON_AMOY_ADDRESS,
  USDC_POLYGON_MAINNET_ADDRESS,
} from './chain-constants.js';

const SOURCE_PATH = fileURLToPath(new URL('chain-constants.ts', import.meta.url));
const ANY_ADDRESS_PATTERN = /0x[\da-f]{40}/gi;

describe('address literals in the constants module', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const literals: string[] = source.match(ANY_ADDRESS_PATTERN) ?? [];

  it('finds the addresses it expects to audit', () => {
    expect(literals.length).toBeGreaterThanOrEqual(3);
  });

  // Scanning the source rather than the exports catches an address added later without a test.
  it.each(literals)('%s is written lowercase', (literal) => {
    expect(literal).toBe(literal.toLowerCase());
  });

  it.each(literals)('%s round-trips through EIP-55 checksumming', (literal) => {
    const checksummed = getAddress(literal);
    expect(checksummed.toLowerCase()).toBe(literal);
    expect(getAddress(checksummed).toLowerCase()).toBe(literal);
  });
});

describe('chain identifiers', () => {
  it('names the Polygon networks', () => {
    expect(POLYGON_MAINNET_CHAIN_IDENTIFIER).toBe(137);
    expect(POLYGON_AMOY_CHAIN_IDENTIFIER).toBe(80_002);
    expect(LOCAL_ANVIL_CHAIN_IDENTIFIER).toBe(31_337);
  });

  it('keeps every network identifier distinct', () => {
    const identifiers = new Set([
      POLYGON_MAINNET_CHAIN_IDENTIFIER,
      POLYGON_AMOY_CHAIN_IDENTIFIER,
      LOCAL_ANVIL_CHAIN_IDENTIFIER,
    ]);
    expect(identifiers.size).toBe(3);
  });
});

describe('token constants', () => {
  it('uses six decimals for USDC, not eighteen', () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it('keeps bridged USDC.e distinct from native USDC', () => {
    expect(USDC_BRIDGED_POLYGON_MAINNET_ADDRESS).not.toBe(USDC_POLYGON_MAINNET_ADDRESS);
  });

  it('uses a different USDC contract per network', () => {
    expect(USDC_POLYGON_AMOY_ADDRESS).not.toBe(USDC_POLYGON_MAINNET_ADDRESS);
  });

  it('carries the keccak256 hash of the ERC-20 Transfer signature', () => {
    expect(ERC20_TRANSFER_EVENT_TOPIC).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
    expect(ERC20_TRANSFER_EVENT_TOPIC).toHaveLength(66);
  });
});

describe('toCanonicalAddress', () => {
  it('lowercases a checksummed address', () => {
    const checksummed = getAddress(USDC_POLYGON_MAINNET_ADDRESS);
    expect(toCanonicalAddress(checksummed)).toBe(USDC_POLYGON_MAINNET_ADDRESS);
  });

  it('trims surrounding whitespace', () => {
    expect(toCanonicalAddress(`  ${USDC_POLYGON_AMOY_ADDRESS}  `)).toBe(USDC_POLYGON_AMOY_ADDRESS);
  });

  it('is idempotent', () => {
    const once = toCanonicalAddress(USDC_POLYGON_AMOY_ADDRESS);
    expect(toCanonicalAddress(once)).toBe(once);
  });

  it.each([
    { description: 'too short', candidate: '0xabc' },
    { description: 'missing prefix', candidate: '3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
    { description: 'non-hex characters', candidate: '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' },
    { description: 'empty', candidate: '' },
    { description: 'one digit too long', candidate: '0x3c499c542cef5e3811e1192ce70d8cc03d5c33590' },
  ])('rejects an address that is $description', ({ candidate }) => {
    expect(() => toCanonicalAddress(candidate)).toThrow(/valid EVM address/);
  });
});

describe('isCanonicalAddress', () => {
  it('accepts a lowercase address', () => {
    expect(isCanonicalAddress(USDC_POLYGON_MAINNET_ADDRESS)).toBe(true);
  });

  it('rejects a checksummed address, because storage is always lowercase', () => {
    expect(isCanonicalAddress(getAddress(USDC_POLYGON_MAINNET_ADDRESS))).toBe(false);
  });
});
