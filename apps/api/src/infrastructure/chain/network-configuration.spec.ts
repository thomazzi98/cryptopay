import {
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
