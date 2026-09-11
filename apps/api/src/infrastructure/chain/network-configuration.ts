import { resolveToken, TOKEN_REGISTRY } from './token-registry.js';
import {
  SOLANA_DEVNET_EXPLORER_BASE_URL,
  SOLANA_DEVNET_GENESIS_IDENTITY,
  SOLANA_MAINNET_EXPLORER_BASE_URL,
  SOLANA_MAINNET_GENESIS_IDENTITY,
  SOLANA_NATIVE_CURRENCY_DECIMALS,
  SOLANA_NATIVE_CURRENCY_SYMBOL,
  TRON_MAINNET_EXPLORER_BASE_URL,
  TRON_MAINNET_GENESIS_IDENTITY,
  TRON_NATIVE_CURRENCY_DECIMALS,
  TRON_NATIVE_CURRENCY_SYMBOL,
  TRON_NILE_EXPLORER_BASE_URL,
  TRON_NILE_GENESIS_IDENTITY,
  NATIVE_ASSET_REFERENCE,
} from '@cryptopay/shared';
import {
  LOCAL_ANVIL_CHAIN_IDENTIFIER,
  POLYGON_AMOY_CHAIN_IDENTIFIER,
  POLYGON_AMOY_EXPLORER_BASE_URL,
  POLYGON_MAINNET_CHAIN_IDENTIFIER,
  POLYGON_MAINNET_EXPLORER_BASE_URL,
  POLYGON_NATIVE_CURRENCY_DECIMALS,
  POLYGON_NATIVE_CURRENCY_SYMBOL,
  USDC_BRIDGED_POLYGON_MAINNET_ADDRESS,
  canonicaliseAccount,
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
  /**
   * What the chain must call itself before it will be scanned: a chain id on EVM, a genesis
   * reference elsewhere. Null on a local development chain, whose genesis is created when the
   * container starts and is therefore read from the node by whatever drives it rather than frozen
   * here. Null means "this network cannot be scanned from configuration", and `requireLedgerIdentity`
   * is what turns that into a refusal rather than an unchecked scan.
   */
  readonly ledgerIdentity: string | null;
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

/**
 * The allowlist is derived from the token registry rather than repeated beside it. Two lists of the
 * same tokens is two lists that can disagree, and the way they disagree is that a currency the API
 * happily quotes is one the scanner never watches, so the customer pays and nothing is ever
 * credited.
 */
function allowlistFrom(network: NetworkIdentifier): readonly AllowedAsset[] {
  return Object.freeze(
    TOKEN_REGISTRY[network]
      .filter((token) => token.kind === 'token')
      .map((token) =>
        Object.freeze({
          reference: token.reference,
          symbol: token.currency,
          decimals: token.decimals,
        }),
      ),
  );
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
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
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
      assetAllowlist: allowlistFrom('polygon-mainnet'),
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
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
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
      assetAllowlist: allowlistFrom('polygon-amoy'),
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
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
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
      assetAllowlist: allowlistFrom('local-anvil'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: '',
    }),

    'tron-local': Object.freeze({
      networkIdentifier: 'tron-local',
      networkFamily: 'tron',
      // A local chain has its own genesis, so there is nothing to freeze here. The adapter is given
      // the identity it read from the node, which is what keeps the guard against scanning the
      // wrong chain real rather than disabled.
      ledgerIdentity: null,
      evmChainId: null,
      addressForm: 'tron-base58check',
      referenceForm: 'bare-hex',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        // A single witness solidifies its own blocks immediately, so the tag exists but tracks the
        // head and proves nothing. Treated as absent rather than trusted.
        supportsFinalityTracking: false,
        supportsMemo: false,
        supportsSettlement: false,
      }),
      displayName: 'Local TRON',
      environment: 'test',
      nativeCurrency: {
        symbol: TRON_NATIVE_CURRENCY_SYMBOL,
        decimals: TRON_NATIVE_CURRENCY_DECIMALS,
      },
      // Low on purpose. A local witness produces a block only when there is a transaction for it,
      // so every confirmation costs a real broadcast; nineteen would make the suite untestable
      // without proving anything the count on a real network proves.
      requiredConfirmations: 2,
      requiresFinalityTag: false,
      maximumReorgDepth: 8,
      assetAllowlist: allowlistFrom('tron-local'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: '',
    }),

    'solana-local': Object.freeze({
      networkIdentifier: 'solana-local',
      networkFamily: 'solana',
      ledgerIdentity: null,
      evmChainId: null,
      addressForm: 'solana-base58',
      referenceForm: 'base58-exact',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: true,
        supportsSettlement: false,
      }),
      displayName: 'Local Solana',
      environment: 'test',
      nativeCurrency: {
        symbol: SOLANA_NATIVE_CURRENCY_SYMBOL,
        decimals: SOLANA_NATIVE_CURRENCY_DECIMALS,
      },
      // Scanning reads finalized slots only, so a scanned slot is already final.
      requiredConfirmations: 1,
      requiresFinalityTag: true,
      maximumReorgDepth: 8,
      assetAllowlist: allowlistFrom('solana-local'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: '',
    }),

    'tron-mainnet': Object.freeze({
      networkIdentifier: 'tron-mainnet',
      networkFamily: 'tron',
      ledgerIdentity: TRON_MAINNET_GENESIS_IDENTITY,
      evmChainId: null,
      addressForm: 'tron-base58check',
      referenceForm: 'bare-hex',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: false,
        // Watched, never signed on: no broadcaster is built for this family. Destinations are still
        // derived from the master seed, so funds are recoverable by an operator holding it, but
        // nothing sweeps them automatically and no API can move them. See docs/limitations.md.
        supportsSettlement: false,
      }),
      displayName: 'TRON',
      environment: 'live',
      nativeCurrency: {
        symbol: TRON_NATIVE_CURRENCY_SYMBOL,
        decimals: TRON_NATIVE_CURRENCY_DECIMALS,
      },
      requiredConfirmations: 19,
      requiresFinalityTag: true,
      maximumReorgDepth: 32,
      assetAllowlist: allowlistFrom('tron-mainnet'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: TRON_MAINNET_EXPLORER_BASE_URL,
    }),

    'tron-nile': Object.freeze({
      networkIdentifier: 'tron-nile',
      networkFamily: 'tron',
      ledgerIdentity: TRON_NILE_GENESIS_IDENTITY,
      evmChainId: null,
      addressForm: 'tron-base58check',
      referenceForm: 'bare-hex',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: false,
        supportsSettlement: false,
      }),
      displayName: 'TRON Nile',
      environment: 'test',
      nativeCurrency: {
        symbol: TRON_NATIVE_CURRENCY_SYMBOL,
        decimals: TRON_NATIVE_CURRENCY_DECIMALS,
      },
      requiredConfirmations: 19,
      requiresFinalityTag: true,
      maximumReorgDepth: 32,
      assetAllowlist: allowlistFrom('tron-nile'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: TRON_NILE_EXPLORER_BASE_URL,
    }),

    'solana-mainnet': Object.freeze({
      networkIdentifier: 'solana-mainnet',
      networkFamily: 'solana',
      ledgerIdentity: SOLANA_MAINNET_GENESIS_IDENTITY,
      evmChainId: null,
      addressForm: 'solana-base58',
      referenceForm: 'base58-exact',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        // Solana Pay carries a reference field, which is the one place across the three families
        // where a memo has somewhere real to go.
        supportsMemo: true,
        supportsSettlement: false,
      }),
      displayName: 'Solana',
      environment: 'live',
      nativeCurrency: {
        symbol: SOLANA_NATIVE_CURRENCY_SYMBOL,
        decimals: SOLANA_NATIVE_CURRENCY_DECIMALS,
      },
      // Scanning reads finalized blocks only, so a scanned slot is already final and no count is
      // waited for on top of it.
      requiredConfirmations: 1,
      requiresFinalityTag: true,
      maximumReorgDepth: 32,
      assetAllowlist: allowlistFrom('solana-mainnet'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: SOLANA_MAINNET_EXPLORER_BASE_URL,
    }),

    'solana-devnet': Object.freeze({
      networkIdentifier: 'solana-devnet',
      networkFamily: 'solana',
      ledgerIdentity: SOLANA_DEVNET_GENESIS_IDENTITY,
      evmChainId: null,
      addressForm: 'solana-base58',
      referenceForm: 'base58-exact',
      capabilities: Object.freeze({
        supportsNativePayments: true,
        supportsTokenPayments: true,
        supportsPaymentUri: true,
        supportsEventMonitoring: true,
        supportsFinalityTracking: true,
        supportsMemo: true,
        supportsSettlement: false,
      }),
      displayName: 'Solana Devnet',
      environment: 'test',
      nativeCurrency: {
        symbol: SOLANA_NATIVE_CURRENCY_SYMBOL,
        decimals: SOLANA_NATIVE_CURRENCY_DECIMALS,
      },
      requiredConfirmations: 1,
      requiresFinalityTag: true,
      maximumReorgDepth: 32,
      assetAllowlist: allowlistFrom('solana-devnet'),
      assetDenylist: Object.freeze([]),
      explorerBaseUrl: SOLANA_DEVNET_EXPLORER_BASE_URL,
    }),
  });

/**
 * The networks whose asset list may be added to at runtime.
 *
 * Every other network's list is a frozen constant, because a token address that can be changed while
 * the process runs is a way to redirect what a payment credits. A development chain genuinely
 * redeploys its token on every start, so there is nothing to freeze.
 *
 * The guarantee that matters is unchanged and is now enforced rather than implied: registration
 * takes a network, and a network outside this set is refused. Naming one of the real networks here
 * would be the mistake, and it is one line to see.
 */
const LOCAL_DEVELOPMENT_NETWORKS: ReadonlySet<NetworkIdentifier> = new Set<NetworkIdentifier>([
  'local-anvil',
  'tron-local',
  'solana-local',
]);

export class NotALocalDevelopmentNetworkError extends Error {
  constructor(network: NetworkIdentifier) {
    super(`${network} is not a local development chain and its asset list cannot be added to`);
    this.name = 'NotALocalDevelopmentNetworkError';
  }
}

const localDevelopmentAssets = new Map<NetworkIdentifier, AllowedAsset[]>();

/**
 * Registers a token deployed by a local chain. The reference is canonicalised for the network's own
 * form rather than lowercased, because lowercasing a base58 address produces one nobody holds a key
 * for, and the whole point of registering it is that a payment will be matched against it.
 */
export function registerLocalDevelopmentAsset(
  network: NetworkIdentifier,
  asset: AllowedAsset,
): void {
  if (!LOCAL_DEVELOPMENT_NETWORKS.has(network)) {
    throw new NotALocalDevelopmentNetworkError(network);
  }
  const reference = canonicaliseAccount(
    NETWORK_CONFIGURATIONS[network].addressForm,
    asset.reference,
  );
  const registered = Object.freeze({ ...asset, reference });
  const assets = localDevelopmentAssets.get(network) ?? [];
  const alreadyRegistered = assets.findIndex((entry) => entry.reference === reference);
  if (alreadyRegistered === -1) {
    assets.push(registered);
    localDevelopmentAssets.set(network, assets);
    return;
  }
  assets[alreadyRegistered] = registered;
  localDevelopmentAssets.set(network, assets);
}

export function networkConfigurationFor(network: NetworkIdentifier): NetworkConfiguration {
  const configuration = NETWORK_CONFIGURATIONS[network];
  const registered = localDevelopmentAssets.get(network);
  if (registered === undefined) {
    return configuration;
  }
  return { ...configuration, assetAllowlist: registered };
}

/**
 * The numeric chain id an EVM adapter needs. Non-EVM families have none, so asking for one is a
 * configuration error rather than something to paper over with a zero.
 */
/**
 * The identity a scanner asserts before reading a block. Absent only on a local development chain,
 * where asking for one is a configuration error rather than something to paper over: scanning a
 * chain without checking which chain it is is how a payment gets credited from the wrong ledger.
 */
export function requireLedgerIdentity(configuration: NetworkConfiguration): string {
  const identity = configuration.ledgerIdentity;
  if (identity === null) {
    throw new Error(
      `${configuration.networkIdentifier} has no configured ledger identity and cannot be scanned from configuration`,
    );
  }
  return identity;
}

export function requireEvmChainId(configuration: NetworkConfiguration): number {
  if (configuration.evmChainId === null) {
    throw new Error(
      `${configuration.networkIdentifier} is a ${configuration.networkFamily} network and has no EVM chain id`,
    );
  }
  return configuration.evmChainId;
}

/**
 * Turns the family a caller names into the deployment their key is allowed to reach.
 *
 * The gateway contract deliberately takes `polygon` rather than `polygon-mainnet`, so which chain a
 * payment lands on follows from the API key's environment rather than from the request body. A test
 * key cannot ask for mainnet, because mainnet is not a word it can say.
 */
export interface ResolveNetworkOptions {
  /**
   * Lets a test-environment family resolve to its local development chain instead of the public
   * testnet, so a whole deployment can be exercised end to end against a chain running beside it.
   *
   * Off by default and refused in production by configuration: a caller naming a family must
   * never reach a local chain by accident, and the exclusion below stays the rule everywhere the
   * operator has not said otherwise for this one non-production deployment.
   */
  readonly preferLocalDevelopmentNetworks?: boolean;
}

export function resolveNetwork(
  family: NetworkFamily,
  environment: Environment,
  options: ResolveNetworkOptions = {},
): NetworkConfiguration | null {
  const candidates = Object.values(NETWORK_CONFIGURATIONS).filter(
    (configuration) =>
      configuration.networkFamily === family && configuration.environment === environment,
  );
  // A local development chain is never what a caller naming a family meant, and it must not be
  // reachable from the public contract at all. The exclusion is by membership of the local set
  // rather than by naming one network, because naming one is exactly how `tron-local` became the
  // network a `cp_test_` key received when it asked for TRON.
  const isLocal = (configuration: NetworkConfiguration): boolean =>
    LOCAL_DEVELOPMENT_NETWORKS.has(configuration.networkIdentifier);
  // The opt-in applies to the test environment only. A live key names live chains, and there is
  // no local stand-in for one.
  const preferLocal = options.preferLocalDevelopmentNetworks === true && environment === 'test';
  const preferred =
    (preferLocal ? candidates.find((configuration) => isLocal(configuration)) : undefined) ??
    candidates.find((configuration) => !isLocal(configuration));
  return preferred === undefined ? null : networkConfigurationFor(preferred.networkIdentifier);
}

/**
 * The currency a gateway caller named, resolved for the network their key reached.
 *
 * The frozen token registry answers for every real network. A local development chain deploys its
 * token on every start, so its address is registered at boot rather than frozen, and only there is
 * the runtime allowlist consulted. A real network never gains a currency this way: the fall-through
 * is gated on membership of the local set, which is one line to see.
 */
export function resolveCurrencyForNetwork(
  network: NetworkIdentifier,
  currency: string,
): { readonly currency: string; readonly reference: string; readonly decimals: number } | null {
  const registered = resolveToken(network, currency);
  if (registered !== null) {
    return registered;
  }
  if (!LOCAL_DEVELOPMENT_NETWORKS.has(network)) {
    return null;
  }
  const allowed = findAllowedAsset(network, currency);
  return allowed === null
    ? null
    : { currency: allowed.symbol, reference: allowed.reference, decimals: allowed.decimals };
}

export function networksForEnvironment(environment: Environment): readonly NetworkConfiguration[] {
  return Object.values(NETWORK_CONFIGURATIONS)
    .filter((configuration) => configuration.environment === environment)
    .map((configuration) => networkConfigurationFor(configuration.networkIdentifier));
}

export function findAllowedAsset(network: NetworkIdentifier, symbol: string): AllowedAsset | null {
  const configuration = networkConfigurationFor(network);
  const wanted = symbol.trim().toUpperCase();
  const token = configuration.assetAllowlist.find((asset) => asset.symbol.toUpperCase() === wanted);
  if (token !== undefined) {
    return configuration.capabilities.supportsTokenPayments ? token : null;
  }

  // The native currency is not in the allowlist and cannot be: the allowlist exists to match a
  // contract address in a transfer log, and a native payment has no contract. It is answered here
  // instead, so that a caller naming POL, TRX or SOL is given the sentinel the rest of the system
  // already understands rather than being told the chain does not settle its own currency.
  const native = configuration.nativeCurrency;
  if (
    !configuration.capabilities.supportsNativePayments ||
    native.symbol.toUpperCase() !== wanted
  ) {
    return null;
  }
  return Object.freeze({
    reference: NATIVE_ASSET_REFERENCE,
    symbol: native.symbol,
    decimals: native.decimals,
  });
}

/**
 * Asset identity is the contract address, never the symbol. Bridged USDC.e reports the same symbol
 * as native USDC, so a symbol comparison anywhere in the credit path would credit the wrong token.
 *
 * The denylist is consulted first and is deliberately redundant. Matching on an allowlist already
 * excludes anything not named in it, so a denied asset could only be credited if somebody added it
 * to the allowlist by mistake — which is exactly the mistake worth a second check, and the reason
 * the entry names the asset and the reason it is denied rather than being a comment.
 */
export function isAllowedAssetReference(network: NetworkIdentifier, reference: string): boolean {
  const configuration = networkConfigurationFor(network);
  if (configuration.assetDenylist.some((asset) => asset.reference === reference)) {
    return false;
  }
  return configuration.assetAllowlist.some((asset) => asset.reference === reference);
}

/**
 * The asset an on-chain reference names, or null when this network does not settle it.
 *
 * Needed wherever an amount has to be rendered against the asset that actually moved rather than
 * the one the payment asked for. A transfer classified `wrong_asset` carries a different asset from
 * its payment, and formatting its amount with the payment's decimals reports the wrong number by a
 * factor of a thousand or a trillion.
 */
export function resolveAssetByReference(
  network: NetworkIdentifier,
  reference: string,
): AllowedAsset | null {
  const configuration = networkConfigurationFor(network);
  if (reference === NATIVE_ASSET_REFERENCE) {
    if (!configuration.capabilities.supportsNativePayments) {
      return null;
    }
    return Object.freeze({
      reference: NATIVE_ASSET_REFERENCE,
      symbol: configuration.nativeCurrency.symbol,
      decimals: configuration.nativeCurrency.decimals,
    });
  }
  return configuration.assetAllowlist.find((asset) => asset.reference === reference) ?? null;
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
