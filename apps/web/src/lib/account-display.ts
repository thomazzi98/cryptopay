import { isCanonicalAccount, NATIVE_ASSET_REFERENCE } from '@cryptopay/shared';
import { getAddress } from 'viem';

/**
 * How an account and an asset are shown to a customer, as opposed to how they are stored.
 *
 * Checksumming is an EVM idea. Mixed case in a hex address encodes a checksum, and rendering one is
 * a courtesy to whoever reads it off the screen. Base58 carries its own checksum and is case
 * significant, so the only correct transformation of a TRON or Solana address is none at all.
 *
 * This module exists because the checkout called viem's `getAddress` on every account and every
 * asset reference it displayed. That function throws on anything which is not forty hex digits, so
 * it threw on every TRON and Solana address, and on the `native` sentinel that every native-currency
 * payment carries as its asset reference — on every family, Polygon included. Five of the six
 * network and currency combinations the product supports could be created and detected but never
 * shown to anybody.
 *
 * A presentation boundary must not be able to fail. Both functions here are total.
 */

export function toDisplayAccount(value: string): string {
  const lowercase = value.trim().toLowerCase();
  if (!isCanonicalAccount('evm-lowercase-hex', lowercase)) {
    return value;
  }
  return getAddress(lowercase);
}

export interface AssetDisplay {
  /** True when the payment is in the chain's own currency, which has no contract to name. */
  readonly isNative: boolean;
  /** What to show beside the amount: a contract address, or the currency's own name. */
  readonly label: string;
}

export function describeAsset(reference: string, symbol: string): AssetDisplay {
  if (reference === NATIVE_ASSET_REFERENCE) {
    return { isNative: true, label: `${symbol}, the network's own currency` };
  }
  return { isNative: false, label: `token ${toDisplayAccount(reference)}` };
}

/**
 * Whether a browser wallet can be offered for this payment at all.
 *
 * The panel speaks EIP-1193 and writes an ERC-20 `transfer`, so it applies to an EVM token payment
 * and to nothing else. A TRON or Solana payment is made by scanning the code, and a native EVM
 * payment is a plain value transfer that this panel does not build. Saying so is better than
 * rendering a button that cannot work, and far better than throwing while deciding.
 */
export function walletPanelApplies(networkFamily: string, assetReference: string): boolean {
  return networkFamily === 'polygon' && assetReference !== NATIVE_ASSET_REFERENCE;
}
