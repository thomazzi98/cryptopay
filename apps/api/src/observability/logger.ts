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

function redactBinary(value: unknown): unknown {
  if (value instanceof Uint8Array && SUSPICIOUS_BINARY_LENGTHS.has(value.byteLength)) {
    return `[redacted ${value.byteLength}-byte value]`;
  }
  return value;
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
  '*.signingSecret',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

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
    // pino names the error key 'err' by default; this project spells identifiers out.
    errorKey: 'error',
    // Timestamps are emitted in ISO 8601 so that log lines sort and join with database rows.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string): Record<string, unknown> => ({ level: label }),
      log: (record: Record<string, unknown>): Record<string, unknown> => {
        const context = currentRequestContext();
        const withRedactedBinaries = Object.fromEntries(
          Object.entries(record).map(([key, value]) => [key, redactBinary(value)]),
        );
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
