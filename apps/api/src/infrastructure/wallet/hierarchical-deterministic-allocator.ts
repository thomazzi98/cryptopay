import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import { publicKeyToAddress } from 'viem/utils';

import { toCanonicalAddress } from '@cryptopay/shared';

import { encodeTronAddress } from '../chain/tron/address.js';
import {
  assertDerivationIndex,
  AddressAllocationError,
  COIN_TYPES,
  type PaymentDestination,
} from './payment-destination.js';

/**
 * Issues one receiving address per payment on the secp256k1 families, at `m/44'/{coin}'/0'/0/{i}`.
 *
 * Allocation derives from the account-level *public* key only. No private key is materialised to
 * hand a customer an address, so the whole creation path — the hottest, most exposed code in the
 * product — never holds signing material at all. Private keys are derived only when a sweep is
 * signed, from the seed, and zeroed immediately after.
 *
 * Polygon and TRON differ in exactly two places: the registered coin type, and how twenty bytes of
 * key hash are written down. Both chains take the last twenty bytes of keccak256 over the
 * uncompressed public key; Polygon prints them as hex, TRON prefixes the constant `0x41` and
 * base58check-encodes the result. Everything between the seed and those twenty bytes is identical,
 * which is why this is one class parameterised twice rather than two implementations that would
 * drift.
 *
 * The derivation index comes from a database sequence rather than from this module. Gaps are
 * harmless in a hierarchical-deterministic wallet, and a counter row would serialise every payment
 * creation on a network to solve a problem that does not exist.
 */

/** A family whose addresses are secp256k1 key hashes. Solana is not one and is not derivable here. */
export type Secp256k1Family = 'polygon' | 'tron';

interface Secp256k1Profile {
  readonly accountPath: string;
  readonly encodeAccount: (keyHash: `0x${string}`) => string;
}

/**
 * TRON reuses the EVM key hash, so `publicKeyToAddress` produces the twenty bytes and only the
 * envelope changes. Deriving the hash a second way would be two chances to be wrong instead of one.
 */
function toTronAccount(keyHash: `0x${string}`): string {
  return encodeTronAddress(`41${keyHash.slice(2).toLowerCase()}`);
}

const PROFILES: Readonly<Record<Secp256k1Family, Secp256k1Profile>> = Object.freeze({
  polygon: Object.freeze({
    accountPath: `m/44'/${COIN_TYPES.polygon}'/0'/0`,
    encodeAccount: (keyHash: `0x${string}`) => toCanonicalAddress(keyHash),
  }),
  tron: Object.freeze({
    accountPath: `m/44'/${COIN_TYPES.tron}'/0'/0`,
    encodeAccount: toTronAccount,
  }),
});

/**
 * Holds the account-level extended public key. Constructed once per environment and family at first
 * use, so the seed is touched once rather than on every payment.
 */
export class HierarchicalDeterministicAllocator {
  private readonly accountKey: HDKey;
  private readonly profile: Secp256k1Profile;

  constructor(seed: Buffer, family: Secp256k1Family) {
    this.profile = PROFILES[family];
    // A copy, because the caller owns the Buffer it passed. Zeroed below for the same reason the
    // derived keys are: a seed left in memory outlives every other precaution taken over it.
    const seedBytes = Uint8Array.from(seed);
    const master = HDKey.fromMasterSeed(seedBytes);
    const account = master.derive(this.profile.accountPath);

    // Keeping only the public half means this object cannot sign, however it is later misused.
    this.accountKey = account.wipePrivateData();
    master.wipePrivateData();
    seedBytes.fill(0);
  }

  allocate(derivationIndex: number): PaymentDestination {
    assertDerivationIndex(derivationIndex);

    const child = this.accountKey.deriveChild(derivationIndex);
    const compressedPublicKey = child.publicKey;
    if (compressedPublicKey === null) {
      throw new AddressAllocationError('Derived child has no public key');
    }

    // An address is the last 20 bytes of keccak256 over the 64-byte uncompressed public key. BIP-32
    // hands back the 33-byte compressed form, and hashing that produces a plausible but entirely
    // wrong address, so the point is decompressed first.
    const uncompressedPublicKey = secp256k1.Point.fromBytes(compressedPublicKey).toBytes(false);
    const keyHash = publicKeyToAddress(`0x${Buffer.from(uncompressedPublicKey).toString('hex')}`);
    return Object.freeze({
      account: this.profile.encodeAccount(keyHash),
      allocationReference: `${this.profile.accountPath}/${derivationIndex}`,
    });
  }
}
