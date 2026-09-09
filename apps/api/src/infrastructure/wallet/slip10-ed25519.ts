import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

/**
 * SLIP-0010 hierarchical derivation over ed25519.
 *
 * BIP-32 is defined for secp256k1 and does not carry over: ed25519 public keys are not points that
 * can be added, so the tweak that produces a non-hardened child has no ed25519 analogue. SLIP-0010
 * resolves this by defining ed25519 derivation as **hardened only**. There is no extended public
 * key and no way to derive a child address without the parent private key.
 *
 * Two consequences, both deliberate and both load-bearing elsewhere:
 *
 * - The private key must be materialised to learn an address. `deriveHardenedPath` therefore hands
 *   back a key its caller is expected to zero, and the only caller does so in a `finally`.
 * - The exposure of a leaked child key stops at that child. Non-hardened secp256k1 derivation leaks
 *   every sibling in the branch once one child key and the account public key are known; hardened
 *   derivation does not. Ed25519 loses one property and gains another.
 *
 * Written here rather than taken from a package because it is twenty lines against a specification
 * with published test vectors, and the spec suite asserts all three ed25519 vectors from SLIP-0010.
 */

const MASTER_KEY_LABEL = 'ed25519 seed';
const HARDENED_OFFSET = 0x80_00_00_00;
const KEY_BYTES = 32;

export interface ExtendedKey {
  readonly privateKey: Uint8Array;
  readonly chainCode: Uint8Array;
}

export class Slip10Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Slip10Error';
  }
}

export function masterKeyFromSeed(seed: Uint8Array): ExtendedKey {
  const digest = hmac(sha512, new TextEncoder().encode(MASTER_KEY_LABEL), seed);
  return { privateKey: digest.slice(0, KEY_BYTES), chainCode: digest.slice(KEY_BYTES) };
}

/**
 * One hardened step. The data is `0x00 || key || index`, where the leading zero byte pads the
 * 32-byte private key to the 33 bytes a secp256k1 public key would have occupied. Omitting it
 * produces a plausible key that matches no wallet.
 */
function deriveHardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  const data = new Uint8Array(1 + KEY_BYTES + 4);
  data[0] = 0;
  data.set(parent.privateKey, 1);
  new DataView(data.buffer).setUint32(1 + KEY_BYTES, (index + HARDENED_OFFSET) >>> 0, false);

  const digest = hmac(sha512, parent.chainCode, data);
  data.fill(0);
  return { privateKey: digest.slice(0, KEY_BYTES), chainCode: digest.slice(KEY_BYTES) };
}

/**
 * Walks a path of hardened indices, zeroing every intermediate key on the way down so only the leaf
 * survives the call.
 */
export function deriveHardenedPath(seed: Uint8Array, indices: readonly number[]): ExtendedKey {
  if (indices.length === 0) {
    throw new Slip10Error('A derivation path must have at least one level');
  }

  let current = masterKeyFromSeed(seed);
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
      throw new Slip10Error(`${index} is not a valid hardened index`);
    }
    const child = deriveHardenedChild(current, index);
    current.privateKey.fill(0);
    current.chainCode.fill(0);
    current = child;
  }
  return current;
}
