import {
  LOCAL_ANVIL_CHAIN_IDENTIFIER,
  POLYGON_AMOY_CHAIN_IDENTIFIER,
  POLYGON_AMOY_EXPLORER_BASE_URL,
  POLYGON_MAINNET_CHAIN_IDENTIFIER,
  POLYGON_MAINNET_EXPLORER_BASE_URL,
  POLYGON_NATIVE_CURRENCY_DECIMALS,
  POLYGON_NATIVE_CURRENCY_SYMBOL,
  USDC_BRIDGED_POLYGON_MAINNET_ADDRESS,
  USDC_DECIMALS,
  USDC_POLYGON_AMOY_ADDRESS,
  USDC_POLYGON_MAINNET_ADDRESS,
  type Environment,
  type NetworkIdentifier,
} from '@cryptopay/shared';

/**
 * Everything that differs between chains, as data.
 *
 * Adding Ethereum or BNB Smart Chain is one more frozen entry here plus RPC URLs, with no new code
 * at all. That is the honest test of whether the chain abstraction is real, and it is the reason
 * this file is a record rather than a set of classes.
 *
 * Two values here are policy rather than fact, and are labelled as such. Nobody publishes a
 * recommended confirmation count for Polygon; its own documentation directs you to the finality
 * tag. The counts below are this project's choice, and the finality tag remains the authoritative
 * gate above them.
 */

export interface AllowedAsset {
  readonly reference: string;
  readonly symbol: string;
  readonly decimals: number;
}

interface DeniedAsset {
  readonly reference: string;
  readonly reason: string;
}

export interface NetworkConfiguration {
  readonly networkIdentifier: NetworkIdentifier;
  readonly chainIdentifier: number;
  readonly displayName: string;
  readonly environment: Environment;
  readonly nativeCurrency: { readonly symbol: string; readonly decimals: number };
  /** POLICY, not a sourced constant. The finality tag is the authoritative gate above this. */
  readonly requiredConfirmations: number;
  readonly requiresFinalityTag: boolean;
  readonly maximumReorgDepth: number;
  readonly assetAllowlist: readonly AllowedAsset[];
  readonly assetDenylist: readonly DeniedAsset[];
  readonly explorerBaseUrl: string;
}

export const NETWORK_CONFIGURATIONS: Readonly<Record<NetworkIdentifier, NetworkConfiguration>> =
  Object.freeze({
    'polygon-mainnet': Object.freeze({
      networkIdentifier: 'polygon-mainnet',
      chainIdentifier: POLYGON_MAINNET_CHAIN_IDENTIFIER,
      displayName: 'Polygon',
      environment: 'live',
      nativeCurrency: {
        symbol: POLYGON_NATIVE_CURRENCY_SYMBOL,
        decimals: POLYGON_NATIVE_CURRENCY_DECIMALS,
      },
      requiredConfirmations: 12,
      requiresFinalityTag: true,
      maximumReorgDepth: 64,
      assetAllowlist: Object.freeze([
        { reference: USDC_POLYGON_MAINNET_ADDRESS, symbol: 'USDC', decimals: USDC_DECIMALS },
      ]),
      // Bridged USDC.e reports the byte-identical symbol "USDC". It is named here so that a transfer
      // of it is recorded as the wrong asset rather than credited.
      assetDenylist: Object.freeze([
        { reference: USDC_BRIDGED_POLYGON_MAINNET_ADDRESS, reason: 'bridged-usdc-e' },
      ]),
      explorerBaseUrl: POLYGON_MAINNET_EXPLORER_BASE_URL,
    }),

    'polygon-amoy': Object.freeze({
      networkIdentifier: 'polygon-amoy',
      chainIdentifier: POLYGON_AMOY_CHAIN_IDENTIFIER,
      displayName: 'Polygon Amoy',
      environment: 'test',
      nativeCurrency: {
        symbol: POLYGON_NATIVE_CURRENCY_SYMBOL,
        decimals: POLYGON_NATIVE_CURRENCY_DECIMALS,
      },
      // Deliberately not 1. Shipping a single confirmation on the testnet ships a race that would
      // only ever be discovered on mainnet.
      requiredConfirmations: 5,
      requiresFinalityTag: true,
      maximumReorgDepth: 32,
      assetAllowlist: Object.freeze([
        { reference: USDC_POLYGON_AMOY_ADDRESS, symbol: 'USDC', decimals: USDC_DECIMALS },
      ]),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: POLYGON_AMOY_EXPLORER_BASE_URL,
    }),

    'local-anvil': Object.freeze({
      networkIdentifier: 'local-anvil',
      chainIdentifier: LOCAL_ANVIL_CHAIN_IDENTIFIER,
      displayName: 'Local Anvil',
      environment: 'test',
      nativeCurrency: { symbol: 'ETH', decimals: 18 },
      requiredConfirmations: 2,
      // A development chain publishes no finality tag, so the count is the only gate available.
      requiresFinalityTag: false,
      maximumReorgDepth: 8,
      // Filled in by the test harness once it has deployed its token; a payment cannot be created
      // against an asset that has not been deployed.
      assetAllowlist: Object.freeze([]),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: '',
    }),
  });

export function networkConfigurationFor(network: NetworkIdentifier): NetworkConfiguration {
  return NETWORK_CONFIGURATIONS[network];
}

export function networksForEnvironment(environment: Environment): readonly NetworkConfiguration[] {
  return Object.values(NETWORK_CONFIGURATIONS).filter(
    (configuration) => configuration.environment === environment,
  );
}

export function findAllowedAsset(network: NetworkIdentifier, symbol: string): AllowedAsset | null {
  const configuration = networkConfigurationFor(network);
  const wanted = symbol.trim().toUpperCase();
  return (
    configuration.assetAllowlist.find((asset) => asset.symbol.toUpperCase() === wanted) ?? null
  );
}

/**
 * Asset identity is the contract address, never the symbol. Bridged USDC.e reports the same symbol
 * as native USDC, so a symbol comparison anywhere in the credit path would credit the wrong token.
 */
export function isAllowedAssetReference(network: NetworkIdentifier, reference: string): boolean {
  return networkConfigurationFor(network).assetAllowlist.some(
    (asset) => asset.reference === reference,
  );
}

export function explorerTransactionUrl(
  network: NetworkIdentifier,
  transactionReference: string,
): string | null {
  const baseUrl = networkConfigurationFor(network).explorerBaseUrl;
  if (baseUrl === '') {
    return null;
  }
  return `${baseUrl}/tx/${transactionReference}`;
}

export function explorerAccountUrl(network: NetworkIdentifier, account: string): string | null {
  const baseUrl = networkConfigurationFor(network).explorerBaseUrl;
  if (baseUrl === '') {
    return null;
  }
  return `${baseUrl}/address/${account}`;
}
