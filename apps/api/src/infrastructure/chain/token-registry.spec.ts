import { describe, expect, it } from 'vitest';

import { networkConfigurationFor, networksForEnvironment } from './network-configuration.js';
import {
  NATIVE_ASSET_REFERENCE,
  registeredTokensFor,
  resolveToken,
  TOKEN_REGISTRY,
  validateTokenRegistry,
  type RegisteredToken,
  type RegistryNetworkShape,
} from './token-registry.js';

/**
 * The registry is the only path from a currency a merchant names to an address this system watches,
 * so every invariant here is one whose failure is silent in production: a payment quoted in the
 * wrong decimals, or watched at an address belonging to another token entirely.
 */

const ALL_NETWORKS = Object.keys(TOKEN_REGISTRY) as (keyof typeof TOKEN_REGISTRY)[];

function shapeOf(network: keyof typeof TOKEN_REGISTRY): RegistryNetworkShape {
  const configuration = networkConfigurationFor(network);
  return {
    networkIdentifier: configuration.networkIdentifier,
    addressForm: configuration.addressForm,
    nativeCurrency: configuration.nativeCurrency,
    supportsNativePayments: configuration.capabilities.supportsNativePayments,
    supportsTokenPayments: configuration.capabilities.supportsTokenPayments,
  };
}

function everyShape(): RegistryNetworkShape[] {
  return ALL_NETWORKS.map((network) => shapeOf(network));
}

describe('the shipped registry', () => {
  it('is frozen, so no request can add a token at runtime', () => {
    expect(Object.isFrozen(TOKEN_REGISTRY)).toBe(true);
    for (const network of ALL_NETWORKS) {
      expect(Object.isFrozen(TOKEN_REGISTRY[network])).toBe(true);
    }
  });

  it('passes its own boot validation', () => {
    expect(() => {
      validateTokenRegistry(everyShape(), TOKEN_REGISTRY);
    }).not.toThrow();
  });

  it('covers every configured network in both environments', () => {
    const configured = [...networksForEnvironment('live'), ...networksForEnvironment('test')];
    for (const network of configured) {
      expect(registeredTokensFor(network.networkIdentifier).length).toBeGreaterThan(0);
    }
  });
});

describe('resolving a currency', () => {
  it('resolves the logical name a merchant sends, case and padding insensitively', () => {
    expect(resolveToken('polygon-mainnet', 'usdc')?.currency).toBe('USDC');
    expect(resolveToken('polygon-mainnet', '  USDC  ')?.currency).toBe('USDC');
  });

  it('resolves USDT on Polygon to the address, not to what the contract calls itself', () => {
    const usdt = resolveToken('polygon-mainnet', 'USDT');
    expect(usdt?.reference).toBe('0xc2132d05d31c914a87c6611c10748aeb04b58e8f');
    expect(usdt?.decimals).toBe(6);
    // Read from the chain: this contract reports USDT0 since the LayerZero migration. Resolving by
    // symbol would have refused the real Polygon USDT outright.
    expect(usdt?.onChainSymbol).toBe('USDT0');
    expect(usdt?.onChainSymbol).not.toBe(usdt?.currency);
  });

  it('resolves a native currency to the sentinel rather than to an address', () => {
    const native = resolveToken('polygon-mainnet', 'POL');
    expect(native?.kind).toBe('native');
    expect(native?.reference).toBe(NATIVE_ASSET_REFERENCE);
    expect(native?.decimals).toBe(18);
  });

  /**
   * The rule that a client may never name a contract address. If an address resolved to anything,
   * a caller could have the system watch a token it knows nothing about and credit what arrived.
   */
  it('refuses a contract address offered where a currency belongs', () => {
    expect(
      resolveToken('polygon-mainnet', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
    ).toBeNull();
    expect(resolveToken('polygon-mainnet', 'native')).toBeNull();
  });

  it('refuses a currency that is real on another network', () => {
    // USDT exists on Polygon mainnet and is deliberately absent from Amoy, where no such contract
    // was verified. Resolving it anyway would watch an address that holds nothing.
    expect(resolveToken('polygon-mainnet', 'USDT')).not.toBeNull();
    expect(resolveToken('polygon-amoy', 'USDT')).toBeNull();
  });

  it('refuses an unknown currency instead of guessing', () => {
    expect(resolveToken('polygon-mainnet', 'DOGE')).toBeNull();
    expect(resolveToken('polygon-mainnet', '')).toBeNull();
  });
});

/** Corrupts one field of the Polygon mainnet shape and leaves the others as shipped. */
function withNetwork(overrides: Partial<RegistryNetworkShape>): RegistryNetworkShape[] {
  return everyShape().map((shape) =>
    shape.networkIdentifier === 'polygon-mainnet' ? { ...shape, ...overrides } : shape,
  );
}

/**
 * Each case corrupts one field and asserts boot refuses. A validator that cannot be made to fail is
 * not evidence of anything.
 */
describe('what boot validation refuses', () => {
  it('refuses a native entry whose decimals disagree with the network', () => {
    expect(() => {
      validateTokenRegistry(
        withNetwork({ nativeCurrency: { symbol: 'POL', decimals: 6 } }),
        TOKEN_REGISTRY,
      );
    }).toThrow(/declares 18 decimals where the network native currency has 6/);
  });

  it('refuses a native entry whose symbol is not the network native currency', () => {
    expect(() => {
      validateTokenRegistry(
        withNetwork({ nativeCurrency: { symbol: 'ETH', decimals: 18 } }),
        TOKEN_REGISTRY,
      );
    }).toThrow(/does not match the network native currency/);
  });

  it('refuses token entries on a network that says it takes no tokens', () => {
    expect(() => {
      validateTokenRegistry(withNetwork({ supportsTokenPayments: false }), TOKEN_REGISTRY);
    }).toThrow(/token entry on a network that declares no token payments/);
  });

  /**
   * The check that catches a base58 address pasted into an EVM row, or an EVM address into a
   * Solana one. Either would compile, store and never match a single transfer.
   */
  it('refuses a reference that is not canonical for the network address form', () => {
    expect(() => {
      validateTokenRegistry(withNetwork({ addressForm: 'base58-exact' }), TOKEN_REGISTRY);
    }).toThrow(/not a canonical base58-exact address/);
  });

  it('refuses to run against a network set that does not cover the registry', () => {
    expect(() => {
      validateTokenRegistry([shapeOf('polygon-mainnet')], TOKEN_REGISTRY);
    }).toThrow(/describes networks that are not configured/);
  });

  it('refuses a network that claims native payments with nothing to resolve them to', () => {
    const tokenOnly: readonly RegisteredToken[] = [
      { currency: 'USDC', reference: '0x' + 'a'.repeat(40), decimals: 6, kind: 'token' },
    ];
    expect(() => {
      validateTokenRegistry([{ ...shapeOf('polygon-mainnet'), supportsNativePayments: true }], {
        'polygon-mainnet': tokenOnly,
      });
    }).toThrow(/claims native payments with no native currency registered/);
  });

  it('refuses a configured network the registry says nothing about', () => {
    expect(() => {
      validateTokenRegistry([shapeOf('polygon-mainnet')], { 'polygon-mainnet': [] });
    }).toThrow(/configured but has no registered currency/);
  });

  it('refuses a currency named in a way the API could never accept', () => {
    expect(() => {
      validateTokenRegistry([shapeOf('polygon-mainnet')], {
        'polygon-mainnet': [
          { currency: 'usdc', reference: '0x' + 'a'.repeat(40), decimals: 6, kind: 'token' },
        ],
      });
    }).toThrow(/2 to 10 uppercase characters/);
  });

  it('refuses the same currency declared twice, which would make resolution depend on order', () => {
    const duplicated: readonly RegisteredToken[] = [
      { currency: 'USDC', reference: '0x' + 'a'.repeat(40), decimals: 6, kind: 'token' },
      { currency: 'USDC', reference: '0x' + 'b'.repeat(40), decimals: 6, kind: 'token' },
    ];
    expect(() => {
      validateTokenRegistry([shapeOf('polygon-mainnet')], { 'polygon-mainnet': duplicated });
    }).toThrow(/declared twice/);
  });

  it('refuses a decimal scale no token has', () => {
    expect(() => {
      validateTokenRegistry([shapeOf('polygon-mainnet')], {
        'polygon-mainnet': [
          { currency: 'USDC', reference: '0x' + 'a'.repeat(40), decimals: 99, kind: 'token' },
        ],
      });
    }).toThrow(/not a plausible token scale/);
  });
});
