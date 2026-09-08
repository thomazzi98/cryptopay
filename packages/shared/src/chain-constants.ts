/**
 * Chain constants that were each confirmed against at least two independent sources, with every
 * token contract read back on chain for its symbol and decimals.
 *
 * Addresses are stored, transported and compared lowercase throughout this codebase. A checksummed
 * string is produced only at a presentation boundary, by viem's getAddress(). Hand-typing a
 * checksummed literal is a lint error: an incorrect EIP-55 casing makes getAddress() throw at boot,
 * and the bytes look identical during review.
 *
 * Values deliberately absent because no authoritative source confirmed them: block times (made
 * runtime-configurable by PIP-75, so they are measured at boot and never used for correctness), RPC
 * endpoint lists (configuration, asserted against eth_chainId at startup), provider log-range caps
 * (discovered by adaptive halving, never by parsing an error message), and required confirmation
 * counts (per-network policy, not a constant).
 */

export const POLYGON_MAINNET_CHAIN_IDENTIFIER = 137;
export const POLYGON_AMOY_CHAIN_IDENTIFIER = 80_002;
export const LOCAL_ANVIL_CHAIN_IDENTIFIER = 31_337;

export const POLYGON_NATIVE_CURRENCY_SYMBOL = 'POL';
export const POLYGON_NATIVE_CURRENCY_DECIMALS = 18;

export const USDC_DECIMALS = 6;

/** Circle-issued native USDC on Polygon PoS. */
export const USDC_POLYGON_MAINNET_ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

/** Circle-issued USDC on Polygon Amoy. */
export const USDC_POLYGON_AMOY_ADDRESS = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';

/**
 * Bridged USDC.e on Polygon PoS. Present so it can be denied, never credited. Its on-chain symbol()
 * returns the byte-identical string "USDC"; only name() differs ("USD Coin (PoS)" against
 * "USD Coin"). Any code that identifies a token by symbol credits this by mistake.
 */
export const USDC_BRIDGED_POLYGON_MAINNET_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * TRON identifies a chain by its genesis block rather than by a number, which is why ledger identity
 * is an opaque string in this system. Read from each network on 8 September 2026. Written with the
 * 0x prefix this codebase uses for every hash, which also keeps a bare sixty-four character hex run
 * out of the source, since that is indistinguishable from a private key to any scanner.
 */
export const TRON_MAINNET_GENESIS_IDENTITY =
  '0x00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
export const TRON_NILE_GENESIS_IDENTITY =
  '0x0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc';

export const TRON_NATIVE_CURRENCY_SYMBOL = 'TRX';
/** One TRX is a million SUN. Not eighteen, which is the assumption an EVM habit would carry over. */
export const TRON_NATIVE_CURRENCY_DECIMALS = 6;

/** Tether on TRON, verified on chain: symbol USDT, six decimals, on both networks. */
export const USDT_TRON_MAINNET_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const USDT_TRON_NILE_ADDRESS = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

export const TRON_MAINNET_EXPLORER_BASE_URL = 'https://tronscan.org/#';
export const TRON_NILE_EXPLORER_BASE_URL = 'https://nile.tronscan.org/#';

export const POLYGON_MAINNET_EXPLORER_BASE_URL = 'https://polygonscan.com';
export const POLYGON_AMOY_EXPLORER_BASE_URL = 'https://amoy.polygonscan.com';

/**
 * The faucets that were confirmed to exist and to work without a mainnet balance gate. The official
 * Polygon faucet is discontinued despite still being linked from several places, so it is absent by
 * intent rather than by oversight.
 */
export const POLYGON_AMOY_STABLECOIN_FAUCET_URL = 'https://faucet.circle.com/';
export const POLYGON_AMOY_GAS_FAUCET_URL = 'https://faucet.quicknode.com/polygon/amoy';

const LOWERCASE_ADDRESS_PATTERN = /^0x[\da-f]{40}$/;

export function isCanonicalAddress(value: string): boolean {
  return LOWERCASE_ADDRESS_PATTERN.test(value);
}

/**
 * Normalizes an address for storage and comparison. Everything that enters the system through an
 * API request, a chain read or configuration passes through here, so that equality is always a
 * plain string comparison and never a checksum-aware one.
 */
export function toCanonicalAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!LOWERCASE_ADDRESS_PATTERN.test(normalized)) {
    throw new Error(`Not a valid EVM address: ${value}`);
  }
  return normalized;
}
