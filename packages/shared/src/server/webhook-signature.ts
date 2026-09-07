import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signing, as both the sender and the receiver use it.
 *
 * The format is deliberately not a bespoke one. A merchant can verify a CryptoPay callback with any
 * off-the-shelf Standard Webhooks library on the first day, and this module is the same code the API
 * signs with, the bundled receiver verifies with, and the tests assert on. A separate verifier
 * written for the documentation is a verifier that drifts.
 *
 * The signed content is `{id}.{timestamp}.{body}`. Signing the id defeats replaying one event's
 * signature onto another; signing the timestamp bounds how long a captured request stays valid.
 */

const SIGNATURE_VERSION = 'v1';
const SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface WebhookSignatureHeaders {
  readonly 'webhook-id': string;
  readonly 'webhook-timestamp': string;
  readonly 'webhook-signature': string;
}

export type SignatureVerification =
  { readonly kind: 'valid' } | { readonly kind: 'invalid'; readonly reason: string };

export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64')}`;
}

/**
 * The secret travels as `whsec_<base64>` and is used as the raw decoded bytes, which is what every
 * Standard Webhooks implementation does. Treating the printable form as the key instead is a silent
 * incompatibility: signatures verify against this codebase and against nothing else.
 */
function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(encoded, 'base64');
}

function computeSignature(secret: string, identifier: string, timestamp: number, body: string) {
  return createHmac('sha256', decodeSecret(secret))
    .update(`${identifier}.${timestamp.toString()}.${body}`)
    .digest('base64');
}

export interface SignatureInput {
  /** Stable across every retry of one event: it is the merchant's idempotency key. */
  readonly identifier: string;
  /** Unix seconds, regenerated on every attempt. */
  readonly timestamp: number;
  /** Serialized exactly once by the caller and transmitted byte for byte. */
  readonly body: string;
  /**
   * Newest first. More than one is sent only during a rotation grace period, so a merchant who has
   * not yet picked up the new secret can still verify with the old one.
   */
  readonly secrets: readonly string[];
}

export function signWebhook(input: SignatureInput): WebhookSignatureHeaders {
  const signatures = input.secrets.map(
    (secret) =>
      `${SIGNATURE_VERSION},${computeSignature(secret, input.identifier, input.timestamp, input.body)}`,
  );

  return {
    'webhook-id': input.identifier,
    'webhook-timestamp': input.timestamp.toString(),
    'webhook-signature': signatures.join(' '),
  };
}

export interface VerificationInput {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw request body as received. Re-serializing an object here reorders keys and never matches. */
  readonly body: string;
  readonly secrets: readonly string[];
  readonly now?: number;
  readonly toleranceSeconds?: number;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  // timingSafeEqual throws on a length mismatch, and the throw itself leaks the length. Comparing
  // the lengths first and returning the same way for every mismatch keeps one exit path.
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function verifyWebhook(input: VerificationInput): SignatureVerification {
  const identifier = input.headers['webhook-id'];
  const timestampHeader = input.headers['webhook-timestamp'];
  const signatureHeader = input.headers['webhook-signature'];

  if (
    identifier === undefined ||
    timestampHeader === undefined ||
    signatureHeader === undefined ||
    identifier === '' ||
    signatureHeader === ''
  ) {
    return { kind: 'invalid', reason: 'the request is missing a webhook signature header' };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp)) {
    return { kind: 'invalid', reason: 'the webhook timestamp is not an integer' };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Bounded in both directions. Rejecting only old timestamps leaves a captured request replayable
  // forever by anyone who can move the receiver's clock backwards or forge a future one.
  if (Math.abs(now - timestamp) > tolerance) {
    return { kind: 'invalid', reason: 'the webhook timestamp is outside the tolerance window' };
  }

  const presented = signatureHeader
    .split(' ')
    .filter((entry) => entry.startsWith(`${SIGNATURE_VERSION},`))
    .map((entry) => entry.slice(SIGNATURE_VERSION.length + 1));
  if (presented.length === 0) {
    return { kind: 'invalid', reason: 'no v1 signature was presented' };
  }

  // Every candidate is compared, and the loop is not exited early on a mismatch, so the time taken
  // does not depend on which secret or which signature happened to match.
  let matched = false;
  for (const secret of input.secrets) {
    const expected = computeSignature(secret, identifier, timestamp, input.body);
    for (const candidate of presented) {
      matched = constantTimeEquals(expected, candidate) || matched;
    }
  }

  if (!matched) {
    return { kind: 'invalid', reason: 'no presented signature matched' };
  }
  return { kind: 'valid' };
}
