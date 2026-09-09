import {
  buildPaymentUri,
  CAPABILITY_NAMES,
  isCanonicalAccount,
  NETWORK_FAMILIES,
  NETWORK_IDENTIFIERS,
  USDC_BRIDGED_POLYGON_MAINNET_ADDRESS,
  USDC_POLYGON_AMOY_ADDRESS,
  USDC_POLYGON_MAINNET_ADDRESS,
  type NetworkIdentifier,
} from '@cryptopay/shared';
import { describe, expect, it } from 'vitest';

import { renderPaymentQrCode } from '../qr/qr-code.js';
import { decodeQrCode } from '../qr/qr-decoder.test-helper.js';
import {
  explorerAccountUrl,
  explorerTransactionUrl,
  findAllowedAsset,
  isAllowedAssetReference,
  NETWORK_CONFIGURATIONS,
  networkConfigurationFor,
  networksForEnvironment,
  NotALocalDevelopmentNetworkError,
  registerLocalDevelopmentAsset,
  requireLedgerIdentity,
  requireEvmChainId,
} from './network-configuration.js';

const ALL_NETWORKS = Object.keys(NETWORK_CONFIGURATIONS) as NetworkIdentifier[];

describe('the network table', () => {
  it('is frozen, so no adapter can register a network at runtime', () => {
    expect(Object.isFrozen(NETWORK_CONFIGURATIONS)).toBe(true);
  });

  /**
   * A local development chain creates its genesis when the container starts, so it has no identity
   * to freeze here and whatever drives it reads one from the node. Every other network must carry
   * one, because scanning a chain without checking which chain it is credits payments from the
   * wrong ledger.
   */
  const LOCAL_DEVELOPMENT_NETWORKS = new Set<NetworkIdentifier>([
    'local-anvil',
    'tron-local',
    'solana-local',
  ]);
  const CONFIGURED_NETWORKS = ALL_NETWORKS.filter(
    (network) => !LOCAL_DEVELOPMENT_NETWORKS.has(network),
  );

  it.each(ALL_NETWORKS)('describes %s completely', (network) => {
    const configuration = networkConfigurationFor(network);
    expect(configuration.displayName.length).toBeGreaterThan(0);
    expect(configuration.requiredConfirmations).toBeGreaterThan(0);
    expect(configuration.maximumReorgDepth).toBeGreaterThan(0);
  });

  it.each(CONFIGURED_NETWORKS)('names the chain %s must prove itself to be', (network) => {
    expect(networkConfigurationFor(network).ledgerIdentity?.length ?? 0).toBeGreaterThan(0);
  });

  it.each(['tron-local', 'solana-local'] as const)(
    'leaves %s without a configured identity, so it cannot be scanned by mistake',
    (network) => {
      const configuration = networkConfigurationFor(network);

      expect(configuration.ledgerIdentity).toBeNull();
      expect(() => requireLedgerIdentity(configuration)).toThrow(/cannot be scanned/);
    },
  );

  it('gives every configured network a distinct ledger identity', () => {
    const identifiers = CONFIGURED_NETWORKS.map(
      (network) => networkConfigurationFor(network).ledgerIdentity,
    );
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  // The property that makes a test key incapable of reaching mainnet: exactly one network is live.
  /**
   * One live deployment per family, which is what makes the gateway contract's promise safe: a
   * caller names a family and the environment picks the network, so two live Polygon networks would
   * make that choice ambiguous rather than determined.
   */
  it('places exactly one live network in each family', () => {
    const live = networksForEnvironment('live');
    const families = live.map((entry) => entry.networkFamily);
    expect(new Set(families).size).toBe(families.length);
    expect(
      live
        .map((entry) => entry.networkIdentifier)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['polygon-mainnet', 'solana-mainnet', 'tron-mainnet']);
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

  const LOCAL_TRON_TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('makes the token creditable on the local chain', () => {
    registerLocalDevelopmentAsset('local-anvil', {
      reference: LOCAL_TOKEN,
      symbol: 'MUSD',
      decimals: 6,
    });
    expect(isAllowedAssetReference('local-anvil', LOCAL_TOKEN)).toBe(true);
  });

  it('registers the same token once however often it is announced', () => {
    registerLocalDevelopmentAsset('local-anvil', {
      reference: LOCAL_TOKEN,
      symbol: 'MUSD',
      decimals: 6,
    });
    registerLocalDevelopmentAsset('local-anvil', {
      reference: LOCAL_TOKEN,
      symbol: 'MUSD',
      decimals: 6,
    });
    expect(
      networkConfigurationFor('local-anvil').assetAllowlist.filter(
        (asset) => asset.reference === LOCAL_TOKEN,
      ),
    ).toHaveLength(1);
  });

  it('cannot add an asset to a real network', () => {
    registerLocalDevelopmentAsset('local-anvil', {
      reference: LOCAL_TOKEN,
      symbol: 'MUSD',
      decimals: 6,
    });
    expect(isAllowedAssetReference('polygon-mainnet', LOCAL_TOKEN)).toBe(false);
    expect(isAllowedAssetReference('polygon-amoy', LOCAL_TOKEN)).toBe(false);
  });

  /**
   * The guarantee is now a runtime refusal rather than a signature that could not express the
   * mistake. Every real network must be rejected by name, so that adding one to the local set is a
   * failing test rather than a silent widening.
   */
  it.each<NetworkIdentifier>([
    'polygon-mainnet',
    'polygon-amoy',
    'tron-mainnet',
    'tron-nile',
    'solana-mainnet',
    'solana-devnet',
  ])('refuses to register an asset on %s', (network) => {
    expect(() =>
      registerLocalDevelopmentAsset(network, {
        reference: LOCAL_TOKEN,
        symbol: 'MUSD',
        decimals: 6,
      }),
    ).toThrow(NotALocalDevelopmentNetworkError);
  });

  /**
   * A base58 reference must survive registration byte for byte. Lowercasing it, which is what the
   * EVM-shaped implementation did to every reference, produces an address nobody holds a key for
   * and a payment that can never be credited.
   */
  it('keeps a TRON reference in the form the chain uses', () => {
    registerLocalDevelopmentAsset('tron-local', {
      reference: LOCAL_TRON_TOKEN,
      symbol: 'USDT',
      decimals: 6,
    });

    expect(isAllowedAssetReference('tron-local', LOCAL_TRON_TOKEN)).toBe(true);
    expect(isAllowedAssetReference('tron-local', LOCAL_TRON_TOKEN.toLowerCase())).toBe(false);
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
  /**
   * Written as "canonical for this network" rather than "lowercase", because lowercase was always
   * the EVM rule. Lowercasing a base58 TRON address does not produce a quieter spelling of the same
   * token; it produces a string that is not an address at all.
   */
  it.each(ALL_NETWORKS)('%s identifies every asset in its own canonical form', (network) => {
    const configuration = networkConfigurationFor(network);
    for (const asset of [...configuration.assetAllowlist, ...configuration.assetDenylist]) {
      expect(isCanonicalAccount(configuration.addressForm, asset.reference)).toBe(true);
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

/**
 * A capability flag is only worth declaring if something refuses when it is false. These assert the
 * consequence rather than the value, so a flag cannot be flipped to true to make a feature look
 * finished without the behaviour behind it also changing.
 */
describe('what each network says it can do', () => {
  it.each(ALL_NETWORKS)('gives %s a family the adapters know', (network) => {
    const configuration = networkConfigurationFor(network);
    expect(NETWORK_FAMILIES).toContain(configuration.networkFamily);
  });

  it.each(ALL_NETWORKS)('keeps %s address form consistent with its family', (network) => {
    const configuration = networkConfigurationFor(network);
    const expected = {
      polygon: 'evm-lowercase-hex',
      tron: 'tron-base58check',
      solana: 'solana-base58',
    }[configuration.networkFamily];
    expect(configuration.addressForm).toBe(expected);
  });

  /**
   * TRON writes addresses in base58 and transaction ids in bare lowercase hex, so the two forms
   * genuinely differ on one network and cannot be collapsed into a single per-network setting.
   */
  it.each(ALL_NETWORKS)('declares how %s names a transaction', (network) => {
    const configuration = networkConfigurationFor(network);
    const expected = { polygon: 'evm-hash', tron: 'bare-hex', solana: 'base58-exact' }[
      configuration.networkFamily
    ];
    expect(configuration.referenceForm).toBe(expected);
  });

  it.each(ALL_NETWORKS)('stores every configured account in %s own canonical form', (network) => {
    const configuration = networkConfigurationFor(network);
    for (const asset of configuration.assetAllowlist) {
      expect(isCanonicalAccount(configuration.addressForm, asset.reference)).toBe(true);
    }
    for (const denied of configuration.assetDenylist) {
      expect(isCanonicalAccount(configuration.addressForm, denied.reference)).toBe(true);
    }
  });

  /**
   * A numeric chain id is an EVM idea. Inventing one for TRON or Solana so that a field could stay
   * non-null is exactly how a chain-neutral seam stops being one.
   */
  it.each(ALL_NETWORKS)('only gives %s an EVM chain id if it is an EVM chain', (network) => {
    const configuration = networkConfigurationFor(network);
    const isEvm = configuration.networkFamily === 'polygon';
    expect(configuration.evmChainId === null).toBe(!isEvm);

    // Asserted without a branch: the helper hands back the id where there is one and refuses where
    // there is not, so one comparison covers both networks that have a chain id and those that
    // never will.
    const resolved = ((): number | null => {
      try {
        return requireEvmChainId(configuration);
      } catch {
        return null;
      }
    })();
    expect(resolved).toBe(configuration.evmChainId);
  });

  it.each(ALL_NETWORKS)('makes %s finality flag agree with the finality gate', (network) => {
    const configuration = networkConfigurationFor(network);
    expect(configuration.capabilities.supportsFinalityTracking).toBe(
      configuration.requiresFinalityTag,
    );
  });

  it.each(ALL_NETWORKS)('never lists an asset on %s if it refuses token payments', (network) => {
    const configuration = networkConfigurationFor(network);
    const listsAssetsWithoutClaimingThem =
      configuration.assetAllowlist.length > 0 && !configuration.capabilities.supportsTokenPayments;
    expect(listsAssetsWithoutClaimingThem).toBe(false);
  });

  /**
   * Settlement signs and broadcasts. A network that claims it without a broadcaster would accept a
   * custodial destination and then be unable to move the money off it.
   */
  it.each(ALL_NETWORKS)('only claims settlement on %s where signing exists', (network) => {
    const configuration = networkConfigurationFor(network);
    const claimsSettlementWithoutSigning =
      configuration.capabilities.supportsSettlement && configuration.evmChainId === null;
    expect(claimsSettlementWithoutSigning).toBe(false);
  });

  /**
   * The strongest form of this assertion available: a network that claims it can produce a payment
   * URI has one produced, drawn as a QR code, and scanned back out of the image. The claim is
   * checked against behaviour rather than against another constant.
   */
  it.each(ALL_NETWORKS)('backs up the payment URI claim on %s by scanning one', (network) => {
    const configuration = networkConfigurationFor(network);
    const asset = configuration.assetAllowlist[0];
    const uriIsClaimed = configuration.capabilities.supportsPaymentUri && asset !== undefined;
    const decoded = uriIsClaimed
      ? decodeQrCode(
          renderPaymentQrCode(
            buildPaymentUri({
              networkFamily: configuration.networkFamily,
              evmChainId: configuration.evmChainId,
              destinationAccount: '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d',
              assetReference: asset.reference,
              assetDecimals: asset.decimals,
              amountInBaseUnits: '25000000',
              memo: null,
            }),
          ).bytes,
        )
      : null;
    expect(decoded === null).toBe(!uriIsClaimed);
    expect(decoded ?? '').toContain(uriIsClaimed ? asset.reference : '');
  });

  it.each(CAPABILITY_NAMES)('declares %s explicitly on every network', (flag) => {
    for (const network of ALL_NETWORKS) {
      expect(typeof networkConfigurationFor(network).capabilities[flag]).toBe('boolean');
    }
  });

  /**
   * A tripwire, and deliberately so. These three are false because the code behind them has not
   * landed, and this test fails the moment somebody flips one without also implementing it. When
   * the native scan path, the payment URI builders and Solana Pay arrive, this test is edited in
   * the same commit as the behaviour it describes, which is the point.
   */
  it('claims no capability whose implementation has not landed', () => {
    for (const network of ALL_NETWORKS) {
      const configuration = networkConfigurationFor(network);
      // Every family now reads native currency: TRON from TransferContract entries, Solana from
      // lamport deltas, and Polygon from block bodies, since a plain value transfer emits no log.
      expect(configuration.capabilities.supportsNativePayments).toBe(true);

      // Solana Pay carries a reference field, which is the only place across the three families
      // where a memo has somewhere real to go. The URI builder refuses one on the other two.
      const memoIsExpressible = configuration.networkFamily === 'solana';
      expect(configuration.capabilities.supportsMemo).toBe(memoIsExpressible);
    }
  });
});
