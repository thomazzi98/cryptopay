import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * How TRON writes an account down, and the one conversion that is easy to get catastrophically
 * wrong.
 *
 * A TRON address is twenty-one bytes: the constant `0x41`, then twenty bytes of key hash. It is
 * presented as base58check, so `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` is that payload plus four
 * checksum bytes.
 *
 * The trap is in the event log. TronGrid returns log topics and the contract address as bare hex
 * with neither an `0x` prefix nor the `0x41` byte, so a recipient arrives as
 * `ea51342dabbb928ae1e576bd39eff8aaf070a8c6`. Reading that as an EVM address produces
 * `0xea51342d...`, which is a valid-looking identity that belongs to nobody, and a payment matched
 * against it is never credited. Prepending `0x41` and re-encoding produces
 * `TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj`, which is the account that was actually paid. Both
 * directions are asserted against transfers read from the Nile network.
 */

const TRON_ADDRESS_PREFIX = 0x41;
const PAYLOAD_BYTES = 21;
const CHECKSUM_BYTES = 4;
const KEY_HASH_BYTES = 20;

export class InvalidTronAddressError extends Error {
  constructor(reason: string) {
    super(`Not a valid TRON address: ${reason}`);
    this.name = 'InvalidTronAddressError';
  }
}

function checksumOf(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).subarray(0, CHECKSUM_BYTES);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalised.length % 2 !== 0 || !/^[\da-f]*$/i.test(normalised)) {
    throw new InvalidTronAddressError('not hexadecimal');
  }
  const bytes = new Uint8Array(normalised.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalised.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The twenty-one byte payload a base58check address carries, as lowercase hex without `0x`. */
export function decodeTronAddress(address: string): string {
  let raw: Uint8Array;
  try {
    raw = base58.decode(address);
  } catch {
    throw new InvalidTronAddressError('not base58');
  }
  if (raw.length !== PAYLOAD_BYTES + CHECKSUM_BYTES) {
    throw new InvalidTronAddressError(`expected 25 bytes, found ${raw.length}`);
  }

  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const expected = checksumOf(payload);
  const actual = raw.subarray(PAYLOAD_BYTES);
  const checksumMatches = expected.every((byte, index) => byte === actual[index]);
  if (!checksumMatches) {
    throw new InvalidTronAddressError('the checksum does not match');
  }
  if (payload[0] !== TRON_ADDRESS_PREFIX) {
    throw new InvalidTronAddressError('the payload does not begin with 0x41');
  }
  return toHex(payload);
}

export function encodeTronAddress(payloadHex: string): string {
  const payload = fromHex(payloadHex);
  if (payload.length !== PAYLOAD_BYTES) {
    throw new InvalidTronAddressError(`expected a 21 byte payload, found ${payload.length}`);
  }
  if (payload[0] !== TRON_ADDRESS_PREFIX) {
    throw new InvalidTronAddressError('the payload does not begin with 0x41');
  }
  const full = new Uint8Array(PAYLOAD_BYTES + CHECKSUM_BYTES);
  full.set(payload, 0);
  full.set(checksumOf(payload), PAYLOAD_BYTES);
  return base58.encode(full);
}

/**
 * Turns the bare twenty-byte form that appears in an event log into a real TRON address.
 *
 * Accepts the padded thirty-two byte form a topic carries as well as the unpadded twenty, because
 * the same value appears both ways in one response: the contract on `log.address` is twenty bytes,
 * and the sender and recipient in `log.topics` are left-padded to thirty-two.
 */
export function tronAddressFromLogValue(value: string): string {
  const bytes = fromHex(value);
  if (bytes.length !== KEY_HASH_BYTES && bytes.length !== 32) {
    throw new InvalidTronAddressError(`a log address is 20 or 32 bytes, found ${bytes.length}`);
  }
  const keyHash = bytes.subarray(bytes.length - KEY_HASH_BYTES);
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload[0] = TRON_ADDRESS_PREFIX;
  payload.set(keyHash, 1);
  return encodeTronAddress(toHex(payload));
}

export function isTronAddress(candidate: string): boolean {
  try {
    decodeTronAddress(candidate);
    return true;
  } catch {
    return false;
  }
}
