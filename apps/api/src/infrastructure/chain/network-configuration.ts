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
  type AddressForm,
  type ReferenceForm,
  type Environment,
  type NetworkCapabilities,
  type NetworkFamily,
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
  readonly networkFamily: NetworkFamily;
  /**
   * The chain's own name for itself, compared as an opaque string. On an EVM chain this is the
   * decimal chain id; on Solana it is the genesis hash; on TRON the first block's identifier. The
   * comparison is what stops an endpoint quietly serving a different chain, and it must not assume
   * the identity is a number, because on two of the three families it is not.
   */
  readonly ledgerIdentity: string;
  /** Present only where the family genuinely has one. Used for EIP-681 and the public chainId. */
  readonly evmChainId: number | null;
  readonly addressForm: AddressForm;
  readonly referenceForm: ReferenceForm;
  readonly capabilities: NetworkCapabilities;
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
      networkFamily: 'polygon',
      ledgerIdentity: String(POLYGON_MAINNET_CHAIN_IDENTIFIER),
      evmChainId: POLYGON_MAINNET_CHAIN_IDENTIFIER,
      addressForm: 'evm-lowercase-hex',
      referenceForm: 'evm-hash',
      capabilities: Object.freeze({
        // Native POL payments are watched only once the block-body scan path lands; declaring the
        // flag true before then would be the exact "fake an unsupported capability" the brief bans.
        supportsNativePayments: false,
        supportsTokenPayments: true,
        // Flipped on with the EIP-681 builder.
        supportsPaymentUri: false,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: false,
        supportsSettlement: true,
      }),
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
      networkFamily: 'polygon',
      ledgerIdentity: String(POLYGON_AMOY_CHAIN_IDENTIFIER),
      evmChainId: POLYGON_AMOY_CHAIN_IDENTIFIER,
      addressForm: 'evm-lowercase-hex',
      referenceForm: 'evm-hash',
      capabilities: Object.freeze({
        // Native POL payments are watched only once the block-body scan path lands; declaring the
        // flag true before then would be the exact "fake an unsupported capability" the brief bans.
        supportsNativePayments: false,
        supportsTokenPayments: true,
        // Flipped on with the EIP-681 builder.
        supportsPaymentUri: false,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: false,
        supportsSettlement: true,
      }),
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
      networkFamily: 'polygon',
      ledgerIdentity: String(LOCAL_ANVIL_CHAIN_IDENTIFIER),
      evmChainId: LOCAL_ANVIL_CHAIN_IDENTIFIER,
      addressForm: 'evm-lowercase-hex',
      referenceForm: 'evm-hash',
      capabilities: Object.freeze({
        supportsNativePayments: false,
        supportsTokenPayments: true,
        supportsPaymentUri: false,
        supportsEventMonitoring: true,
        // A development chain publishes no finality tag, so there is nothing to track.
        supportsFinalityTracking: false,
        supportsMemo: false,
        supportsSettlement: true,
      }),
      displayName: 'Local Anvil',
      environment: 'test',
      nativeCurrency: { symbol: 'ETH', decimals: 18 },
      requiredConfirmations: 2,
      // A development chain publishes no finality tag, so the count is the only gate available.
      requiresFinalityTag: false,
      maximumReorgDepth: 8,
      // Empty by construction. A development chain deploys a fresh token on every start, so its
      // address is registered at boot through registerLocalDevelopmentAsset rather than frozen here.
      assetAllowlist: Object.freeze([]),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: '',
    }),
  });

/**
 * Assets deployed by a local development chain, registered at boot.
 *
 * Every other network's asset list is a frozen constant, because a token address that can be changed
 * at runtime is a way to redirect what a payment credits. A development chain genuinely redeploys its
 * token on every start, so there is nothing to freeze; the signature accepts no network argument, so
 * this cannot become a way to add an asset to Polygon.
 */
const localDevelopmentAssets: AllowedAsset[] = [];

export function registerLocalDevelopmentAsset(asset: AllowedAsset): void {
  const reference = asset.reference.toLowerCase();
  const registered = Object.freeze({ ...asset, reference });
  const alreadyRegistered = localDevelopmentAssets.findIndex(
    (entry) => entry.reference === reference,
  );
  if (alreadyRegistered === -1) {
    localDevelopmentAssets.push(registered);
    return;
  }
  localDevelopmentAssets[alreadyRegistered] = registered;
}

export function networkConfigurationFor(network: NetworkIdentifier): NetworkConfiguration {
  const configuration = NETWORK_CONFIGURATIONS[network];
  if (network !== 'local-anvil') {
    return configuration;
  }
  return { ...configuration, assetAllowlist: localDevelopmentAssets };
}

/**
 * The numeric chain id an EVM adapter needs. Non-EVM families have none, so asking for one is a
 * configuration error rather than something to paper over with a zero.
 */
export function requireEvmChainId(configuration: NetworkConfiguration): number {
  if (configuration.evmChainId === null) {
    throw new Error(
      `${configuration.networkIdentifier} is a ${configuration.networkFamily} network and has no EVM chain id`,
    );
  }
  return configuration.evmChainId;
}

export function networksForEnvironment(environment: Environment): readonly NetworkConfiguration[] {
  return Object.values(NETWORK_CONFIGURATIONS)
    .filter((configuration) => configuration.environment === environment)
    .map((configuration) => networkConfigurationFor(configuration.networkIdentifier));
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
