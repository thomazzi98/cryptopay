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

const BASE58_ACCOUNT_MINIMUM = 32;
const BASE58_ACCOUNT_MAXIMUM = 44;

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
  return (
    value.length >= BASE58_ACCOUNT_MINIMUM &&
    value.length <= BASE58_ACCOUNT_MAXIMUM &&
    BASE58_PATTERN.test(value)
  );
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
