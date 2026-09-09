import type { AddressForm } from './network-descriptor.js';

/**
 * How an account or a transaction reference is written down, per network family.
 *
 * The rule this replaces was "addresses are lowercase", applied everywhere. That was always an EVM
 * rule wearing a universal one's clothes. Base58 encodes information in case: `TXLAQ63Xg1...` and
 * `txlaq63xg1...` are not the same string, the second one is not a valid address at all, and money
 * sent to a lowercased destination is unrecoverable by anyone. So canonicalisation becomes per
 * network rather than global, and the EVM guarantee gets stronger on the way past, because it now
 * asserts the hex shape as well as the case.
 *
 * Shape only. A TRON base58check checksum needs a hash function and belongs in the adapter that
 * already has one; this module is imported by the browser bundle and stays dependency free.
 */

const EVM_ACCOUNT_PATTERN = /^0x[\da-f]{40}$/;
const EVM_REFERENCE_PATTERN = /^0x[\da-f]{64}$/;

/** Base58 omits 0, O, I and l precisely so they cannot be confused when read aloud or by eye. */
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * A TRON address is base58check over twenty-one payload bytes, which is always thirty-four
 * characters and always begins with `T`. The checksum itself needs a hash function and is verified
 * in the adapter that has one; this module is imported by the browser bundle and stays dependency
 * free, so it asserts the shape that separates TRON from Solana and leaves the rest to the adapter.
 */
const TRON_ACCOUNT_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

const BASE58_ACCOUNT_MINIMUM = 32;
const BASE58_ACCOUNT_MAXIMUM = 44;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RADIX = 58n;
const BITS_PER_BYTE = 8n;

/** An ed25519 public key, which is what a Solana address is: no prefix, no checksum, no hash. */
const SOLANA_ACCOUNT_BYTES = 32;

/**
 * How many bytes a base58 string decodes to, or -1 when it is not base58 at all.
 *
 * Length in characters cannot separate a TRON address from a Solana one: TRON is a twenty-five byte
 * base58check payload written in thirty-four characters, which sits inside the thirty-two to
 * forty-four a thirty-two byte Solana key occupies. Both are base58 and both are accounts, and a
 * payment sent to the wrong chain's address is unrecoverable, so the shapes have to be told apart by
 * what they decode to rather than by how long they look.
 *
 * Decoding needs arbitrary-precision arithmetic and no hash, so this module stays dependency free
 * and remains safe for the browser bundle. A leading `1` encodes a leading zero byte and carries no
 * value, which is why those are counted separately rather than multiplied in.
 */
function base58ByteLength(value: string): number {
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') {
    leadingZeroBytes += 1;
  }

  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit === -1) {
      return -1;
    }
    decoded = decoded * BASE58_RADIX + BigInt(digit);
  }

  let significantBytes = 0;
  let remaining = decoded;
  while (remaining > 0n) {
    remaining >>= BITS_PER_BYTE;
    significantBytes += 1;
  }
  return leadingZeroBytes + significantBytes;
}

const BARE_HEX_REFERENCE_PATTERN = /^[\da-f]{64}$/;
const BASE58_REFERENCE_MINIMUM = 64;
const BASE58_REFERENCE_MAXIMUM = 90;

/**
 * How a transaction is named. Separate from the address form because TRON writes addresses in
 * base58 and transaction ids in bare lowercase hex, so one form cannot answer both questions.
 */
export type ReferenceForm = 'evm-hash' | 'bare-hex' | 'base58-exact';

export class NonCanonicalAccountError extends Error {
  constructor(form: AddressForm, value: string) {
    super(`Not a canonical ${form} account`);
    this.name = 'NonCanonicalAccountError';
    // The offending value is deliberately absent from the message: these strings end up in logs and
    // in API errors, and echoing an attacker-supplied one back is how a log becomes an injection.
    void value;
  }
}

export function isCanonicalAccount(form: AddressForm, value: string): boolean {
  if (form === 'evm-lowercase-hex') {
    return EVM_ACCOUNT_PATTERN.test(value);
  }
  if (form === 'tron-base58check') {
    return TRON_ACCOUNT_PATTERN.test(value);
  }
  const withinLength =
    value.length >= BASE58_ACCOUNT_MINIMUM && value.length <= BASE58_ACCOUNT_MAXIMUM;
  if (!withinLength || !BASE58_PATTERN.test(value)) {
    return false;
  }
  // Decoded rather than measured, so a TRON address is rejected here rather than accepted as a
  // Solana one it merely resembles.
  return base58ByteLength(value) === SOLANA_ACCOUNT_BYTES;
}

/**
 * Puts a value into the form this network stores and compares in.
 *
 * For EVM that is lowercasing, so a checksummed address from a merchant is accepted and normalised.
 * For base58 it is doing nothing whatsoever, which is the entire point: the only safe transformation
 * of a base58 address is none, and this function exists so that "no transformation" is a decision
 * somebody made rather than a branch somebody forgot.
 */
export function canonicaliseAccount(form: AddressForm, value: string): string {
  const trimmed = value.trim();
  const candidate = form === 'evm-lowercase-hex' ? trimmed.toLowerCase() : trimmed;
  if (!isCanonicalAccount(form, candidate)) {
    throw new NonCanonicalAccountError(form, candidate);
  }
  return candidate;
}

export function isCanonicalReference(form: ReferenceForm, value: string): boolean {
  if (form === 'evm-hash') {
    return EVM_REFERENCE_PATTERN.test(value);
  }
  if (form === 'bare-hex') {
    return BARE_HEX_REFERENCE_PATTERN.test(value);
  }
  return (
    value.length >= BASE58_REFERENCE_MINIMUM &&
    value.length <= BASE58_REFERENCE_MAXIMUM &&
    BASE58_PATTERN.test(value)
  );
}

export function canonicaliseReference(form: ReferenceForm, value: string): string {
  const trimmed = value.trim();
  const candidate = form === 'base58-exact' ? trimmed : trimmed.toLowerCase();
  if (!isCanonicalReference(form, candidate)) {
    throw new Error(`Not a canonical ${form} transaction reference`);
  }
  return candidate;
}
