import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';

import {
  assertDerivationIndex,
  COIN_TYPES,
  type PaymentDestination,
} from './payment-destination.js';
import { deriveHardenedPath } from './slip10-ed25519.js';

/**
 * Issues one receiving address per payment on Solana, at `m/44'/501'/{index}'/0'`.
 *
 * A Solana address *is* the ed25519 public key, base58-encoded — there is no hash step and no
 * checksum. Nothing is lowercased on the way out: base58 is case sensitive, and a lowercased
 * address is not a different spelling of the account but a string nobody holds a key for.
 *
 * The path is the one Phantom and the Ledger app use, so an operator recovering this seed in a
 * standard wallet finds the funds where they expect rather than at a private convention.
 *
 * Unlike the secp256k1 families, this function needs the seed. Ed25519 derivation is hardened-only
 * (see `slip10-ed25519.ts`), so there is no account public key that could stand in for it. The
 * caller opens the seed, calls this once, and zeroes it; the private key derived here is zeroed
 * before the address is returned and is never stored, logged, signed with or exposed.
 */

const PURPOSE_INDEX = 44;
const CHANGE_INDEX = 0;
const ACCOUNT_PATH_PREFIX = `m/${PURPOSE_INDEX}'/${COIN_TYPES.solana}'`;

export function allocateSolanaDestination(
  seed: Buffer,
  derivationIndex: number,
): PaymentDestination {
  assertDerivationIndex(derivationIndex);

  const derived = deriveHardenedPath(new Uint8Array(seed), [
    PURPOSE_INDEX,
    COIN_TYPES.solana,
    derivationIndex,
    CHANGE_INDEX,
  ]);
  try {
    return Object.freeze({
      account: base58.encode(ed25519.getPublicKey(derived.privateKey)),
      allocationReference: `${ACCOUNT_PATH_PREFIX}/${derivationIndex}'/${CHANGE_INDEX}'`,
    });
  } finally {
    derived.privateKey.fill(0);
    derived.chainCode.fill(0);
  }
}
