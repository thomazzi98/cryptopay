import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Environment } from '@cryptopay/shared';

import { isUlid, ULID_LENGTH, type UlidFactory } from '../system/ulid.js';

/**
 * API keys are `cp_<environment>_<keyIdentifier>_<secret>`.
 *
 * The environment is in the key itself, which is what makes a test key and a live key impossible to
 * confuse: the value a merchant pastes says which world it belongs to, and a database CHECK makes a
 * test key incapable of producing a mainnet row even if the guard were bypassed.
 *
 * The key identifier is the non-secret half. It is indexed, so verification is a single primary-key
 * lookup rather than a scan comparing digests. Only a digest of the secret half is stored.
 *
 * The digest is HMAC-SHA256 under a server-held pepper rather than a slow password hash. These are
 * 256-bit secrets that this server generated, so there is no dictionary to attack and no user-chosen
 * password to protect; a slow KDF would add latency to every request and buy nothing. The pepper
 * means a database copy alone does not permit offline verification.
 */

const SECRET_BYTE_LENGTH = 32;
const KEY_PATTERN = /^cp_(test|live)_([\dABCDEFGHJKMNPQRSTVWXYZ]{26})_([A-Za-z\d_-]{43})$/;

export interface GeneratedApiKey {
  readonly keyIdentifier: string;
  readonly presentedKey: string;
  readonly secretDigest: Buffer;
  readonly lastFour: string;
  readonly environment: Environment;
}

export interface ParsedApiKey {
  readonly environment: Environment;
  readonly keyIdentifier: string;
  readonly secret: string;
}

export function digestApiKeySecret(secret: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest();
}

export function generateApiKey(
  environment: Environment,
  pepper: string,
  ulidFactory: UlidFactory,
  now: number,
): GeneratedApiKey {
  const identifier = ulidFactory.create(now);
  const secret = randomBytes(SECRET_BYTE_LENGTH).toString('base64url');

  return {
    keyIdentifier: `ak_${identifier}`,
    presentedKey: `cp_${environment}_${identifier}_${secret}`,
    secretDigest: digestApiKeySecret(secret, pepper),
    lastFour: secret.slice(-4),
    environment,
  };
}

/**
 * Parses without touching the database. A malformed key is rejected before any query runs, so an
 * unauthenticated caller cannot use the authentication path to probe for load.
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  const match = KEY_PATTERN.exec(presented.trim());
  if (match === null) {
    return null;
  }

  const identifier = match[2] ?? '';
  if (!isUlid(identifier) || identifier.length !== ULID_LENGTH) {
    return null;
  }

  const environment = match[1] as Environment;
  const secret = match[3] ?? '';
  return { environment, keyIdentifier: `ak_${identifier}`, secret };
}

/**
 * Constant-time comparison. `timingSafeEqual` throws when the lengths differ, and a thrown
 * exception is itself a timing signal, so the length check is done first and always returns false.
 */
export function apiKeySecretMatches(
  presentedSecret: string,
  storedDigest: Buffer,
  pepper: string,
): boolean {
  const candidate = digestApiKeySecret(presentedSecret, pepper);
  if (candidate.length !== storedDigest.length) {
    return false;
  }
  return timingSafeEqual(candidate, storedDigest);
}
