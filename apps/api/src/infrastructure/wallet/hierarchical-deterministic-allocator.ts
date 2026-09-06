import { secp256k1 } from '@noble/curves/secp256k1.js';
import { HDKey } from '@scure/bip32';
import { publicKeyToAddress } from 'viem/utils';

import { toCanonicalAddress } from '@cryptopay/shared';

/**
 * Issues one receiving address per payment, derived at `m/44'/60'/0'/0/{index}`.
 *
 * Allocation derives from the account-level *public* key only. No private key is materialised to
 * hand a customer an address, so the whole creation path — the hottest, most exposed code in the
 * product — never holds signing material at all. Private keys are derived only when a sweep is
 * signed, from the seed, and zeroed immediately after.
 *
 * The derivation index comes from a database sequence rather than from this module. Gaps are
 * harmless in a hierarchical-deterministic wallet, and a counter row would serialise every payment
 * creation on a network to solve a problem that does not exist.
 */

const ACCOUNT_PATH = "m/44'/60'/0'/0";
const MAXIMUM_INDEX = 2_147_483_647;

export interface AllocatedPaymentAddress {
  readonly account: string;
  /**
   * The derivation path. Present so a sweep can find the key again, and deliberately absent from
   * every API contract: no response type declares a field it could travel in.
   */
  readonly allocationReference: string;
}

export class AddressAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressAllocationError';
  }
}

/**
 * Holds the account-level extended public key. Constructed once per environment at startup so the
 * seed is touched once rather than on every payment.
 */
export class HierarchicalDeterministicAllocator {
  private readonly accountKey: HDKey;

  constructor(seed: Buffer) {
    const master = HDKey.fromMasterSeed(new Uint8Array(seed));
    const account = master.derive(ACCOUNT_PATH);

    // Keeping only the public half means this object cannot sign, however it is later misused.
    this.accountKey = account.wipePrivateData();
    master.wipePrivateData();
  }

  allocate(derivationIndex: number): AllocatedPaymentAddress {
    if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0) {
      throw new AddressAllocationError(`A derivation index must be a non-negative integer`);
    }
    if (derivationIndex > MAXIMUM_INDEX) {
      throw new AddressAllocationError(
        `A derivation index must stay below the hardened range (${MAXIMUM_INDEX})`,
      );
    }

    const child = this.accountKey.deriveChild(derivationIndex);
    const compressedPublicKey = child.publicKey;
    if (compressedPublicKey === null) {
      throw new AddressAllocationError('Derived child has no public key');
    }

    // An Ethereum address is the last 20 bytes of keccak256 over the 64-byte uncompressed public
    // key. BIP-32 hands back the 33-byte compressed form, and hashing that produces a plausible but
    // entirely wrong address, so the point is decompressed first.
    const uncompressedPublicKey = secp256k1.Point.fromBytes(compressedPublicKey).toBytes(false);
    const account = publicKeyToAddress(`0x${Buffer.from(uncompressedPublicKey).toString('hex')}`);
    return Object.freeze({
      account: toCanonicalAddress(account),
      allocationReference: `${ACCOUNT_PATH}/${derivationIndex}`,
    });
  }
}
