import {
  NETWORK_IDENTIFIERS,
  USDC_BRIDGED_POLYGON_MAINNET_ADDRESS,
  USDC_POLYGON_AMOY_ADDRESS,
  USDC_POLYGON_MAINNET_ADDRESS,
  type NetworkIdentifier,
} from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import {
  explorerAccountUrl,
  explorerTransactionUrl,
  findAllowedAsset,
  isAllowedAssetReference,
  NETWORK_CONFIGURATIONS,
  networkConfigurationFor,
  networksForEnvironment,
  registerLocalDevelopmentAsset,
} from './network-configuration.js';

const ALL_NETWORKS = Object.keys(NETWORK_CONFIGURATIONS) as NetworkIdentifier[];

describe('the network table', () => {
  it('is frozen, so no adapter can register a network at runtime', () => {
    expect(Object.isFrozen(NETWORK_CONFIGURATIONS)).toBe(true);
  });

  it.each(ALL_NETWORKS)('describes %s completely', (network) => {
    const configuration = networkConfigurationFor(network);
    expect(configuration.chainIdentifier).toBeGreaterThan(0);
    expect(configuration.displayName.length).toBeGreaterThan(0);
    expect(configuration.requiredConfirmations).toBeGreaterThan(0);
    expect(configuration.maximumReorgDepth).toBeGreaterThan(0);
  });

  it('gives every network a distinct chain identifier', () => {
    const identifiers = ALL_NETWORKS.map(
      (network) => networkConfigurationFor(network).chainIdentifier,
    );
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  // The property that makes a test key incapable of reaching mainnet: exactly one network is live.
  it('places exactly one network in the live environment', () => {
    expect(networksForEnvironment('live').map((entry) => entry.networkIdentifier)).toStrictEqual([
      'polygon-mainnet',
    ]);
  });

  it('places the remaining networks in the test environment', () => {
    const testNetworks = networksForEnvironment('test').map((entry) => entry.networkIdentifier);
    expect(testNetworks).toContain('polygon-amoy');
    expect(testNetworks).toContain('local-anvil');
  });

  it('requires the finality tag on both Polygon networks', () => {
    expect(networkConfigurationFor('polygon-mainnet').requiresFinalityTag).toBe(true);
    expect(networkConfigurationFor('polygon-amoy').requiresFinalityTag).toBe(true);
  });

  // A development chain publishes no finality tag, so requiring one would stall every payment.
  it('does not require the finality tag on the local chain', () => {
    expect(networkConfigurationFor('local-anvil').requiresFinalityTag).toBe(false);
  });

  // Shipping a single confirmation on the testnet would ship a race only mainnet would reveal.
  it('requires more than one confirmation on the testnet', () => {
    expect(networkConfigurationFor('polygon-amoy').requiredConfirmations).toBeGreaterThan(1);
  });
});

describe('asset resolution', () => {
  it('finds USDC on each Polygon network', () => {
    expect(findAllowedAsset('polygon-amoy', 'USDC')?.reference).toBe(USDC_POLYGON_AMOY_ADDRESS);
    expect(findAllowedAsset('polygon-mainnet', 'USDC')?.reference).toBe(
      USDC_POLYGON_MAINNET_ADDRESS,
    );
  });

  it('matches the symbol case-insensitively for the merchant request', () => {
    expect(findAllowedAsset('polygon-amoy', 'usdc')).not.toBeNull();
    expect(findAllowedAsset('polygon-amoy', ' USDC ')).not.toBeNull();
  });

  it('uses six decimals for USDC, not eighteen', () => {
    expect(findAllowedAsset('polygon-amoy', 'USDC')?.decimals).toBe(6);
  });

  it('returns nothing for an asset the network does not settle', () => {
    expect(findAllowedAsset('polygon-amoy', 'DAI')).toBeNull();
  });

  it('settles nothing on the local chain until a token is deployed', () => {
    expect(findAllowedAsset('local-anvil', 'USDC')).toBeNull();
  });
});

/**
 * A development chain redeploys its token on every start, so its address is registered at boot
 * rather than frozen. The property that matters is that this cannot reach any other network: a token
 * address settable at runtime on Polygon would be a way to redirect what a payment credits.
 */
describe('registering a local development asset', () => {
  const LOCAL_TOKEN = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

  it('makes the token creditable on the local chain', () => {
    registerLocalDevelopmentAsset({ reference: LOCAL_TOKEN, symbol: 'MUSD', decimals: 6 });
    expect(isAllowedAssetReference('local-anvil', LOCAL_TOKEN)).toBe(true);
  });

  it('registers the same token once however often it is announced', () => {
    registerLocalDevelopmentAsset({ reference: LOCAL_TOKEN, symbol: 'MUSD', decimals: 6 });
    registerLocalDevelopmentAsset({ reference: LOCAL_TOKEN, symbol: 'MUSD', decimals: 6 });
    expect(
      networkConfigurationFor('local-anvil').assetAllowlist.filter(
        (asset) => asset.reference === LOCAL_TOKEN,
      ),
    ).toHaveLength(1);
  });

  it('cannot add an asset to a real network', () => {
    registerLocalDevelopmentAsset({ reference: LOCAL_TOKEN, symbol: 'MUSD', decimals: 6 });
    expect(isAllowedAssetReference('polygon-mainnet', LOCAL_TOKEN)).toBe(false);
    expect(isAllowedAssetReference('polygon-amoy', LOCAL_TOKEN)).toBe(false);
  });

  /**
   * Bridged USDC.e returns the byte-identical symbol "USDC" on chain. Identity is therefore the
   * contract address, and a transfer of the bridged token must not be creditable.
   */
  it('does not accept bridged USDC.e as an allowed asset', () => {
    expect(isAllowedAssetReference('polygon-mainnet', USDC_BRIDGED_POLYGON_MAINNET_ADDRESS)).toBe(
      false,
    );
    expect(isAllowedAssetReference('polygon-mainnet', USDC_POLYGON_MAINNET_ADDRESS)).toBe(true);
  });

  it('names bridged USDC.e on the denylist so a transfer of it is classified, not ignored', () => {
    const denied = networkConfigurationFor('polygon-mainnet').assetDenylist;
    expect(denied.map((entry) => entry.reference)).toContain(USDC_BRIDGED_POLYGON_MAINNET_ADDRESS);
  });

  it('does not accept a testnet asset reference on mainnet', () => {
    expect(isAllowedAssetReference('polygon-mainnet', USDC_POLYGON_AMOY_ADDRESS)).toBe(false);
  });
});

describe('explorer links', () => {
  it('builds a transaction link for each Polygon network', () => {
    expect(explorerTransactionUrl('polygon-amoy', '0xabc')).toBe(
      'https://amoy.polygonscan.com/tx/0xabc',
    );
    expect(explorerTransactionUrl('polygon-mainnet', '0xabc')).toBe(
      'https://polygonscan.com/tx/0xabc',
    );
  });

  it('builds an account link', () => {
    expect(explorerAccountUrl('polygon-amoy', '0xdef')).toBe(
      'https://amoy.polygonscan.com/address/0xdef',
    );
  });

  // A local chain has no explorer, and inventing a dead link is worse than showing none.
  it('reports no link for the local chain', () => {
    expect(explorerTransactionUrl('local-anvil', '0xabc')).toBeNull();
    expect(explorerAccountUrl('local-anvil', '0xdef')).toBeNull();
  });
});

/**
 * The rules a new entry has to satisfy, asserted over every entry rather than over the ones that
 * exist today.
 *
 * This is what makes "adding a network is one frozen entry" a claim that can fail. Someone adding
 * Ethereum or BNB Smart Chain writes data, and these tests are what tell them the data is wrong —
 * a checksummed token address, or a token named on both lists, would otherwise be discovered by a
 * customer whose transfer was never credited.
 */
describe('the rules any new network must satisfy', () => {
  it.each(ALL_NETWORKS)('%s identifies every asset by a lowercase address', (network) => {
    const configuration = networkConfigurationFor(network);
    for (const asset of [...configuration.assetAllowlist, ...configuration.assetDenylist]) {
      expect(asset.reference).toBe(asset.reference.toLowerCase());
    }
  });

  it.each(ALL_NETWORKS)('%s never credits an asset it also denies', (network) => {
    const configuration = networkConfigurationFor(network);
    const denied = new Set(configuration.assetDenylist.map((asset) => asset.reference));
    for (const asset of configuration.assetAllowlist) {
      expect(denied.has(asset.reference)).toBe(false);
    }
  });

  it.each(ALL_NETWORKS)('%s lists each creditable asset once', (network) => {
    const references = networkConfigurationFor(network).assetAllowlist.map(
      (asset) => asset.reference,
    );
    expect(new Set(references).size).toBe(references.length);
  });

  it.each(ALL_NETWORKS)('%s states decimals rather than assuming eighteen', (network) => {
    for (const asset of networkConfigurationFor(network).assetAllowlist) {
      expect(asset.decimals).toBeGreaterThanOrEqual(0);
      expect(asset.decimals).toBeLessThanOrEqual(36);
    }
  });

  it.each(ALL_NETWORKS)('%s can absorb a reorg deeper than it waits for', (network) => {
    const configuration = networkConfigurationFor(network);
    expect(configuration.maximumReorgDepth).toBeGreaterThanOrEqual(
      configuration.requiredConfirmations,
    );
  });

  // A trailing slash produces a link with a double slash, which some explorers answer with a 404.
  it.each(ALL_NETWORKS)('%s carries an explorer base URL that is usable as a prefix', (network) => {
    const baseUrl = networkConfigurationFor(network).explorerBaseUrl;
    if (baseUrl === '') {
      return;
    }
    expect(baseUrl.startsWith('https://')).toBe(true);
    expect(baseUrl.endsWith('/')).toBe(false);
  });

  it('names every network in the shared identifier list, so no adapter can invent one', () => {
    for (const network of ALL_NETWORKS) {
      expect(NETWORK_IDENTIFIERS).toContain(network);
    }
    expect(ALL_NETWORKS).toHaveLength(NETWORK_IDENTIFIERS.length);
  });
});
