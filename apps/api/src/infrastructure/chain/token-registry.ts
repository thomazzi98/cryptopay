import {
  isCanonicalAccount,
  USDC_POLYGON_AMOY_ADDRESS,
  USDC_POLYGON_MAINNET_ADDRESS,
  USDC_SOLANA_DEVNET_MINT,
  USDC_SOLANA_MAINNET_MINT,
  USDT_TRON_MAINNET_ADDRESS,
  USDT_TRON_NILE_ADDRESS,
  type AddressForm,
  type NetworkIdentifier,
} from '@cryptopay/shared';

/**
 * What a merchant may ask to be paid in, and what that resolves to on each chain.
 *
 * The public API takes a logical currency - USDC, USDT, POL, TRX, SOL - and never a contract
 * address. A caller who could name an address could name any address, and the system would then
 * watch for a token it knows nothing about and credit whatever arrived. Resolution runs one way
 * only: a network and a currency in, an entry from this frozen table out.
 *
 * Identity is the reference, never the symbol. Two facts read off the chain make that concrete
 * rather than theoretical. Bridged USDC.e on Polygon reports the byte-identical symbol string
 * "USDC", and the Polygon USDT contract reports "USDT0" after the LayerZero migration. A system
 * that matched on symbol would credit the wrong token in one direction and refuse the right one in
 * the other.
 */

/** Native currency has no contract, so it carries a sentinel that is not a valid address anywhere. */
export const NATIVE_ASSET_REFERENCE = 'native';

export interface RegisteredToken {
  /** The logical name the API accepts, uppercase. */
  readonly currency: string;
  /** Contract or mint address, or the native sentinel. This is the asset's identity. */
  readonly reference: string;
  readonly decimals: number;
  readonly kind: 'native' | 'token';
  /**
   * What the contract itself reports, where that differs from the logical name. Recorded so the
   * difference is documented rather than rediscovered, and never compared against.
   */
  readonly onChainSymbol?: string;
}

const POLYGON_USDT_MAINNET_ADDRESS = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';

export const TOKEN_REGISTRY: Readonly<Record<NetworkIdentifier, readonly RegisteredToken[]>> =
  Object.freeze({
    'polygon-mainnet': Object.freeze([
      Object.freeze({
        currency: 'POL',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 18,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDC',
        reference: USDC_POLYGON_MAINNET_ADDRESS,
        decimals: 6,
        kind: 'token' as const,
      }),
      Object.freeze({
        currency: 'USDT',
        reference: POLYGON_USDT_MAINNET_ADDRESS,
        decimals: 6,
        kind: 'token' as const,
        // Read from the chain on 8 September 2026. The contract renamed itself; the address did not.
        onChainSymbol: 'USDT0',
      }),
    ]),

    'polygon-amoy': Object.freeze([
      Object.freeze({
        currency: 'POL',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 18,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDC',
        reference: USDC_POLYGON_AMOY_ADDRESS,
        decimals: 6,
        kind: 'token' as const,
      }),
    ]),

    'tron-mainnet': Object.freeze([
      Object.freeze({
        currency: 'TRX',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 6,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDT',
        reference: USDT_TRON_MAINNET_ADDRESS,
        decimals: 6,
        kind: 'token' as const,
      }),
    ]),

    'tron-nile': Object.freeze([
      Object.freeze({
        currency: 'TRX',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 6,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDT',
        reference: USDT_TRON_NILE_ADDRESS,
        decimals: 6,
        kind: 'token' as const,
      }),
    ]),

    'solana-mainnet': Object.freeze([
      Object.freeze({
        currency: 'SOL',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 9,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDC',
        reference: USDC_SOLANA_MAINNET_MINT,
        decimals: 6,
        kind: 'token' as const,
      }),
    ]),

    'solana-devnet': Object.freeze([
      Object.freeze({
        currency: 'SOL',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 9,
        kind: 'native' as const,
      }),
      Object.freeze({
        currency: 'USDC',
        reference: USDC_SOLANA_DEVNET_MINT,
        decimals: 6,
        kind: 'token' as const,
      }),
    ]),

    // A development chain deploys a fresh token on every start, so no token entry can be frozen
    // here and one is registered at boot instead. The native entry is stable.
    'local-anvil': Object.freeze([
      Object.freeze({
        currency: 'ETH',
        reference: NATIVE_ASSET_REFERENCE,
        decimals: 18,
        kind: 'native' as const,
      }),
    ]),
  });

export function registeredTokensFor(network: NetworkIdentifier): readonly RegisteredToken[] {
  return TOKEN_REGISTRY[network];
}

/**
 * The only way a currency becomes an asset. Comparison is on the trimmed uppercase logical name,
 * which is a name this system chose, never a string a contract reported.
 */
export function resolveToken(network: NetworkIdentifier, currency: string): RegisteredToken | null {
  const wanted = currency.trim().toUpperCase();
  return TOKEN_REGISTRY[network].find((token) => token.currency === wanted) ?? null;
}

export interface RegistryNetworkShape {
  readonly networkIdentifier: NetworkIdentifier;
  readonly addressForm: AddressForm;
  readonly nativeCurrency: { readonly symbol: string; readonly decimals: number };
  readonly supportsNativePayments: boolean;
  readonly supportsTokenPayments: boolean;
}

const LOGICAL_CURRENCY_PATTERN = /^[A-Z\d]{2,10}$/;
const MAXIMUM_PLAUSIBLE_DECIMALS = 36;

/**
 * Passed in rather than reached for, so the validator can be driven to every one of its failures by
 * a test. A guard that cannot be made to fire is not evidence that it works.
 */
export type TokenTable = Readonly<Record<string, readonly RegisteredToken[]>>;

/**
 * Runs at boot in every process and throws before anything listens.
 *
 * A registry defect is not an error that surfaces somewhere convenient. It is a payment quoted in
 * the wrong decimals, or watched at an address belonging to a different token, and both are silent.
 * Every check here is one whose failure would otherwise be discovered by a customer.
 */
export function validateTokenRegistry(
  networks: readonly RegistryNetworkShape[],
  registry: TokenTable,
): void {
  const covered = new Set<string>();

  for (const network of networks) {
    covered.add(network.networkIdentifier);
    const tokens = registry[network.networkIdentifier] ?? [];
    if (tokens.length === 0) {
      throw new Error(`${network.networkIdentifier}: configured but has no registered currency`);
    }
    const seen = new Set<string>();

    for (const token of tokens) {
      assertToken(network, token, seen);
    }
    assertNativeCoverage(network, tokens);
  }

  const uncovered = Object.keys(registry).filter((network) => !covered.has(network));
  if (uncovered.length > 0) {
    throw new Error(
      `Token registry describes networks that are not configured: ${uncovered.join(', ')}`,
    );
  }
}

function assertToken(
  network: RegistryNetworkShape,
  token: RegisteredToken,
  seen: Set<string>,
): void {
  const where = `${network.networkIdentifier}/${token.currency}`;
  if (!LOGICAL_CURRENCY_PATTERN.test(token.currency)) {
    throw new Error(`${where}: a logical currency must be 2 to 10 uppercase characters`);
  }
  if (seen.has(token.currency)) {
    throw new Error(`${where}: declared twice, so resolution would depend on ordering`);
  }
  seen.add(token.currency);

  const decimalsArePlausible =
    Number.isSafeInteger(token.decimals) &&
    token.decimals >= 0 &&
    token.decimals <= MAXIMUM_PLAUSIBLE_DECIMALS;
  if (!decimalsArePlausible) {
    throw new Error(`${where}: decimals ${token.decimals} is not a plausible token scale`);
  }

  if (token.kind === 'native') {
    assertNativeEntry(network, token, where);
    return;
  }

  if (!isCanonicalAccount(network.addressForm, token.reference)) {
    throw new Error(
      `${where}: reference is not a canonical ${network.addressForm} address, so it would never match a transfer`,
    );
  }
  if (!network.supportsTokenPayments) {
    throw new Error(`${where}: token entry on a network that declares no token payments`);
  }
}

function assertNativeEntry(
  network: RegistryNetworkShape,
  token: RegisteredToken,
  where: string,
): void {
  if (token.reference !== NATIVE_ASSET_REFERENCE) {
    throw new Error(`${where}: a native entry must carry the native sentinel as its reference`);
  }
  if (token.decimals !== network.nativeCurrency.decimals) {
    throw new Error(
      `${where}: declares ${token.decimals} decimals where the network native currency has ${network.nativeCurrency.decimals}`,
    );
  }
  if (token.currency !== network.nativeCurrency.symbol.toUpperCase()) {
    throw new Error(
      `${where}: does not match the network native currency ${network.nativeCurrency.symbol}`,
    );
  }
}

/**
 * A network that says it accepts native payments must have somewhere to resolve them to. The
 * opposite direction is deliberately allowed: an entry may sit here before the scan path that
 * observes it lands, because the capability flag is what gates the offer.
 */
function assertNativeCoverage(
  network: RegistryNetworkShape,
  tokens: readonly RegisteredToken[],
): void {
  const lacksNative = tokens.every((token) => token.kind !== 'native');
  if (lacksNative && network.supportsNativePayments) {
    throw new Error(
      `${network.networkIdentifier}: claims native payments with no native currency registered`,
    );
  }
}
