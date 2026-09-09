import { AsyncLocalStorage } from 'node:async_hooks';

import { pino, type DestinationStream, type Logger } from 'pino';

import type { Configuration } from '../configuration.js';

/**
 * Structured logging with a correlation identifier carried implicitly through the call stack, so a
 * use case does not need a logger parameter threaded into it purely to keep events traceable.
 *
 * Two protections matter more than the formatting:
 *
 * - A redaction list covers the fields that would leak a secret if a whole object were logged.
 * - A serializer refuses to render any 32 or 64 byte binary value. Those are exactly the sizes of a
 *   private key, a wrapped data key and a seed, and the realistic way one reaches a log is that
 *   somebody logs a whole object during an incident rather than naming the field.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly paymentId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, operation: () => T): T {
  return requestContextStorage.run(context, operation);
}

export function currentRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

const SUSPICIOUS_BINARY_LENGTHS = new Set([32, 64]);

/**
 * Field names that carry a secret wherever they appear, rather than only at the depths pino's
 * wildcard list happens to reach.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'privateKey',
  'mnemonic',
  'masterSeed',
  'seed',
  'signingSecret',
  'secretDigest',
  'apiKey',
  'authorization',
  'allocationReference',
  'derivationIndex',
  'derivationPath',
  'chainCode',
]);

/**
 * How deep the walk goes before it stops looking. Six is past anything this system logs on purpose,
 * and a bound is what keeps a pathological object from turning a log line into a hang.
 */
const MAXIMUM_REDACTION_DEPTH = 6;

const CENSORED = '[redacted]';

/**
 * Redacts secrets anywhere in a logged value, not merely at its surface.
 *
 * Two holes closed here. The size-based net used to be applied by mapping over the top-level entries
 * of the record, so a thirty-two byte key one level down was rendered byte for byte, and the module
 * comment above promising that it "refuses to render any 32 or 64 byte binary value" was untrue.
 * Separately, pino's `redact.paths` matches one path segment per star, so the `*.*.` entries stop at
 * depth two and a field literally named `privateKey` below that was written out in full.
 *
 * The name list stays as well. pino applies it before this runs and does so more cheaply, so this is
 * the net beneath it rather than a replacement for it.
 */
function redactBinary(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Uint8Array) {
    return SUSPICIOUS_BINARY_LENGTHS.has(value.byteLength)
      ? `[redacted ${value.byteLength.toString()}-byte value]`
      : value;
  }
  if (value === null || typeof value !== 'object' || depth >= MAXIMUM_REDACTION_DEPTH) {
    return value;
  }
  // A cycle is not a secret, but walking one forever turns a log call into an outage.
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactBinary(entry, depth + 1, seen));
  }
  // Anything with a prototype of its own may compute properties on access, and an Error is already
  // handled by its own serializer. Walking one here would be a second, worse implementation.
  if (value instanceof Error || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_FIELD_NAMES.has(key) ? CENSORED : redactBinary(entry, depth + 1, seen),
    ]),
  );
}

const REDACTED_PATHS = [
  'privateKey',
  'testnetPrivateKey',
  'amoyTestnetPrivateKey',
  'mnemonic',
  'masterSeed',
  'seed',
  'signingSecret',
  'secretDigest',
  'apiKey',
  'authorization',
  'allocationReference',
  'derivationIndex',
  'derivationPath',
  '*.privateKey',
  '*.mnemonic',
  '*.masterSeed',
  '*.seed',
  '*.signingSecret',
  '*.secretDigest',
  '*.apiKey',
  '*.authorization',
  // Two levels, because an object logged during an incident is rarely flat. pino's wildcard matches
  // one segment only, so a seed inside a nested payload escapes the single-star rules above.
  '*.*.privateKey',
  '*.*.mnemonic',
  '*.*.masterSeed',
  '*.*.seed',
  '*.*.signingSecret',
  '*.*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Rewrites every URL in a string to its scheme and host, dropping the path, query and fragment.
 *
 * This exists because of one specific leak. RPC providers put the API key in the path
 * (`https://polygon-mainnet.g.alchemy.com/v2/<key>`), a failing endpoint raises a viem error that
 * carries that URL in `url`, in `metaMessages` and inside `message`, and the worker logs the whole
 * error on every failed tick. Redacting the `url` field alone leaves it in the other two.
 *
 * The host is kept deliberately. "Alchemy is rate limiting us" is the whole diagnostic value of the
 * line, and it survives; only the part that authenticates is removed.
 */
export function redactUrls(text: string): string {
  return text.replaceAll(/https?:\/\/[^\s"']+/gi, (match) => {
    try {
      const parsed = new URL(match);
      const suffix = parsed.pathname === '/' && parsed.search === '' ? '' : '/[redacted]';
      return `${parsed.protocol}//${parsed.host}${suffix}`;
    } catch {
      return '[redacted url]';
    }
  });
}

/**
 * Renders an error without the fields that carry credentials.
 *
 * pino's default error serializer copies own enumerable properties, and viem's errors have ten of
 * them including `url`, `body` and `headers`. Naming what is kept rather than what is dropped means
 * a new field in a future version of a library is excluded by default rather than logged by default.
 */
function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: redactUrls(String(error)) };
  }
  return {
    name: error.name,
    message: redactUrls(error.message),
    ...(error.stack !== undefined && { stack: redactUrls(error.stack) }),
    ...(error.cause instanceof Error && {
      cause: { name: error.cause.name, message: redactUrls(error.cause.message) },
    }),
  };
}

/** What the rest of the system depends on, so only this module names the logging library. */
export type StructuredLogger = Logger;

/**
 * The destination is a parameter so that tests can assert on what is actually written. A redaction
 * rule that is never read back is a rule nobody knows is broken.
 */
export function createLogger(
  configuration: Configuration,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: configuration.logLevel,
    base: { service: 'cryptopay-api', environment: configuration.nodeEnvironment },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Registered under both spellings: this project writes 'error', and pino's own default is
    // 'err', which a library logging through this instance would use.
    serializers: { error: serializeError, ['err']: serializeError },
    // pino names the error key 'err' by default; this project spells identifiers out.
    errorKey: 'error',
    // Timestamps are emitted in ISO 8601 so that log lines sort and join with database rows.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string): Record<string, unknown> => ({ level: label }),
      log: (record: Record<string, unknown>): Record<string, unknown> => {
        const context = currentRequestContext();
        const withRedactedBinaries = redactBinary(record) as Record<string, unknown>;
        if (context === undefined) {
          return withRedactedBinaries;
        }
        return { ...withRedactedBinaries, ...context };
      },
    },
  } as const;

  if (destination === undefined) {
    return pino(options);
  }
  return pino(options, destination);
}
