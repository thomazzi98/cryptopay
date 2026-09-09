import type { NetworkFamily } from '@cryptopay/shared';

/**
 * Where a customer sends money, in terms no chain owns.
 *
 * The account is an opaque string. Above this file nothing knows whether it is forty hex digits, a
 * base58check payload beginning with `T`, or an ed25519 public key, and that is what keeps the
 * payment aggregate, the use cases and the API contract free of any one chain's spelling.
 */
export interface PaymentDestination {
  readonly account: string;
  /**
   * The derivation path. Present so an operator holding the seed can find the key again, and
   * deliberately absent from every API contract: no response type declares a field it could travel
   * in, and the log redaction list names it.
   */
  readonly allocationReference: string;
}

/**
 * How one family turns a derivation index into a destination — and, more importantly, what it needs
 * in hand to do so.
 *
 * The two arms are not a style choice. secp256k1 supports non-hardened derivation, so a child
 * address is computable from an account-level *public* key and the payment creation path never
 * holds signing material at all. Ed25519 has no such operation: SLIP-0010 defines ed25519
 * derivation as hardened-only, there is no extended public key, and every child requires the parent
 * private key. Solana therefore cannot be given the property Polygon and TRON have, however the
 * code is arranged.
 *
 * Making that a discriminated union rather than a comment means the provider is forced to handle
 * the difference, and a reader can see which families expose a seed without reading an
 * implementation.
 */
export interface PublicKeyAllocator {
  allocate(derivationIndex: number): PaymentDestination;
}

export type AddressStrategy =
  | {
      readonly kind: 'public-key-only';
      readonly fromSeed: (seed: Buffer) => PublicKeyAllocator;
    }
  | {
      readonly kind: 'requires-seed';
      readonly deriveWithSeed: (seed: Buffer, derivationIndex: number) => PaymentDestination;
    };

/**
 * BIP-44 coin types. Registered values from SLIP-0044, not conventions: an address derived under the
 * wrong coin type is a real address that no wallet restoring this seed would ever look at.
 */
export const COIN_TYPES: Readonly<Record<NetworkFamily, number>> = Object.freeze({
  polygon: 60,
  tron: 195,
  solana: 501,
});

/**
 * The highest index the schema and both curves agree on. Non-hardened secp256k1 derivation stops
 * below the hardened range, and the hardened Solana path uses the same number as its hardened
 * offset, so one bound serves all three families and matches the CHECK on `derivation_index`.
 */
export const MAXIMUM_DERIVATION_INDEX = 2_147_483_647;

export class AddressAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressAllocationError';
  }
}

export function assertDerivationIndex(derivationIndex: number): void {
  if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0) {
    throw new AddressAllocationError('A derivation index must be a non-negative integer');
  }
  if (derivationIndex > MAXIMUM_DERIVATION_INDEX) {
    throw new AddressAllocationError(
      `A derivation index must stay below the hardened range (${MAXIMUM_DERIVATION_INDEX})`,
    );
  }
}
