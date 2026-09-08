/**
 * What a network is, as data rather than as a branch.
 *
 * Three questions get asked about a network everywhere in this system, and each of them used to be
 * answered by assuming Polygon. This file makes them explicit so that a fourth network is a row
 * rather than a search for the places that guessed.
 *
 * - Which family is it, so the right adapter, payment URI builder and address codec are selected.
 * - How is an account written down, because the EVM rule that addresses are lowercase is an EVM
 *   rule. Base58 is case sensitive: a lowercased TRON or Solana address is a different address, and
 *   money sent to it is unrecoverable by anyone.
 * - What can it actually do, so that an unsupported combination is refused rather than faked.
 */

export type NetworkFamily = 'polygon' | 'tron' | 'solana';

export const NETWORK_FAMILIES: readonly NetworkFamily[] = Object.freeze([
  'polygon',
  'tron',
  'solana',
]);

export function isNetworkFamily(value: string): value is NetworkFamily {
  return (NETWORK_FAMILIES as readonly string[]).includes(value);
}

/**
 * How accounts and transaction references are written on this network.
 *
 * `evm-lowercase-hex` is 0x followed by forty lowercase hex digits, normalised by lowercasing.
 * `base58-exact` is base58 and is normalised by doing nothing at all, which is the entire point:
 * the only safe transformation of a base58 address is none.
 */
export type AddressForm = 'evm-lowercase-hex' | 'base58-exact';

/**
 * What a network supports. Every flag here is false somewhere and drives a refusal that a test
 * exercises; a flag that is true everywhere documents nothing and is not worth declaring.
 */
export interface NetworkCapabilities {
  readonly supportsNativePayments: boolean;
  readonly supportsTokenPayments: boolean;
  readonly supportsPaymentUri: boolean;
  readonly supportsEventMonitoring: boolean;
  readonly supportsFinalityTracking: boolean;
  readonly supportsMemo: boolean;
  /**
   * Whether this system can sign and broadcast on this network at all. False means a payment here
   * can be watched but never swept, which is what makes a custodial destination model refusable
   * rather than a way to strand money at an address nothing can spend from.
   */
  readonly supportsSettlement: boolean;
}

export const CAPABILITY_NAMES: readonly (keyof NetworkCapabilities)[] = Object.freeze([
  'supportsNativePayments',
  'supportsTokenPayments',
  'supportsPaymentUri',
  'supportsEventMonitoring',
  'supportsFinalityTracking',
  'supportsMemo',
  'supportsSettlement',
]);
