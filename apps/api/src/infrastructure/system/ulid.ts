import { randomBytes } from 'node:crypto';

/**
 * ULIDs, generated here rather than taken from a package because the common implementations fall
 * back to Math.random when they cannot detect a secure source, and these identifiers appear in
 * URLs and API keys.
 *
 * The encoding is Crockford base32: 48 bits of millisecond timestamp followed by 80 bits of
 * randomness, 26 characters in total. Lexicographic order matches creation order, so `ORDER BY id`
 * is a valid time ordering and cursor pagination needs no second column.
 *
 * Identifiers issued within the same millisecond are made monotonic by incrementing the random
 * component rather than redrawing it, so two payments created in the same tick still sort in
 * creation order.
 */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIMESTAMP_LENGTH = 10;
const RANDOMNESS_LENGTH = 16;
export const ULID_LENGTH = TIMESTAMP_LENGTH + RANDOMNESS_LENGTH;

const RANDOMNESS_BITS = 80n;
const MAXIMUM_RANDOMNESS = (1n << RANDOMNESS_BITS) - 1n;
const MAXIMUM_TIMESTAMP = 281_474_976_710_655; // 2^48 - 1, the year 10889

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = '';
  for (let position = 0; position < length; position += 1) {
    encoded = CROCKFORD_ALPHABET[Number(remaining % 32n)] + encoded;
    remaining /= 32n;
  }
  return encoded;
}

function drawRandomness(): bigint {
  return BigInt(`0x${randomBytes(10).toString('hex')}`);
}

export class UlidFactory {
  private lastTimestamp = -1;
  private lastRandomness = 0n;

  /** `now` is supplied by the caller so that generation stays deterministic under test. */
  create(now: number): string {
    if (!Number.isSafeInteger(now) || now < 0 || now > MAXIMUM_TIMESTAMP) {
      throw new RangeError(`Timestamp out of range for a ULID: ${now}`);
    }

    if (now === this.lastTimestamp && this.lastRandomness < MAXIMUM_RANDOMNESS) {
      this.lastRandomness += 1n;
      return (
        encodeBase32(BigInt(now), TIMESTAMP_LENGTH) +
        encodeBase32(this.lastRandomness, RANDOMNESS_LENGTH)
      );
    }

    this.lastTimestamp = now;
    this.lastRandomness = drawRandomness();
    return (
      encodeBase32(BigInt(now), TIMESTAMP_LENGTH) +
      encodeBase32(this.lastRandomness, RANDOMNESS_LENGTH)
    );
  }
}

const ULID_PATTERN = new RegExp(`^[${CROCKFORD_ALPHABET}]{${ULID_LENGTH}}$`);

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Prefixed identifiers make an identifier self-describing in a log line and make it impossible to
 * pass a webhook delivery id where a payment id belongs.
 */
export type IdentifierPrefix = 'mch' | 'ak' | 'pay' | 'adr' | 'trf' | 'whe' | 'whd' | 'sed' | 'stl';

export function isPrefixedIdentifier(value: string, prefix: IdentifierPrefix): boolean {
  return value.startsWith(`${prefix}_`) && isUlid(value.slice(prefix.length + 1));
}
