import { Writable } from 'node:stream';

import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';

import { loadConfiguration } from '../configuration.js';
import {
  createLogger,
  currentRequestContext,
  redactUrls,
  runWithRequestContext,
} from './logger.js';

const REQUIRED_ENVIRONMENT = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://cryptopay:cryptopay@127.0.0.1:5432/cryptopay',
  API_KEY_PEPPER: 'a'.repeat(32),
  WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
};

function captureLogOutput(write: (logger: ReturnType<typeof createLogger>) => void): string[] {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });

  const configuration = loadConfiguration({ ...REQUIRED_ENVIRONMENT, LOG_LEVEL: 'trace' });
  write(createLogger(configuration, destination));
  return lines;
}

describe('log redaction', () => {
  it.each([
    'privateKey',
    'mnemonic',
    'masterSeed',
    'signingSecret',
    'apiKey',
    'allocationReference',
    'derivationIndex',
  ])('redacts %s', (field) => {
    const secret = 'a-value-that-must-never-be-logged';
    const lines = captureLogOutput((logger) => {
      logger.info({ [field]: secret }, 'writing a sensitive field');
    });

    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).toContain('[redacted]');
  });

  it('redacts a nested sensitive field', () => {
    const secret = 'nested-secret-value';
    const lines = captureLogOutput((logger) => {
      logger.info({ wallet: { privateKey: secret } }, 'writing a nested field');
    });
    expect(lines.join('')).not.toContain(secret);
  });

  it('redacts the authorization header when a whole request is logged', () => {
    const lines = captureLogOutput((logger) => {
      logger.info({ ['req']: { headers: { authorization: 'Bearer cp_test_secret' } } }, 'request');
    });
    expect(lines.join('')).not.toContain('cp_test_secret');
  });

  // The realistic way key material reaches a log is that somebody logs a whole object during an
  // incident rather than naming the field, so size alone must be enough to refuse it.
  it.each([32, 64])(
    'refuses to serialize a %d-byte binary value under any field name',
    (length) => {
      const material = new Uint8Array(length).fill(7);
      const lines = captureLogOutput((logger) => {
        logger.info({ somethingNobodyThoughtToRedact: material }, 'writing raw bytes');
      });

      const output = lines.join('');
      expect(output).toContain(`[redacted ${length}-byte value]`);
      expect(output).not.toContain('"0":7');
    },
  );

  it('still logs binary values that are not key-sized', () => {
    const lines = captureLogOutput((logger) => {
      logger.info({ payload: new Uint8Array(4).fill(1) }, 'writing a short buffer');
    });
    expect(lines.join('')).not.toContain('[redacted');
  });

  it('logs an ordinary field untouched', () => {
    const lines = captureLogOutput((logger) => {
      logger.info({ paymentId: 'pay_01K4QW' }, 'ordinary field');
    });
    expect(lines.join('')).toContain('pay_01K4QW');
  });
});

describe('request correlation', () => {
  it('attaches the current request identifier to every line', () => {
    const lines = captureLogOutput((logger) => {
      runWithRequestContext({ requestId: 'req-abc' }, () => {
        logger.info({ event: 'test.event' }, 'inside a request');
      });
    });
    expect(lines.join('')).toContain('req-abc');
  });

  it('omits correlation outside a request, rather than inventing one', () => {
    const lines = captureLogOutput((logger) => {
      logger.info({ event: 'test.event' }, 'outside a request');
    });
    expect(lines.join('')).not.toContain('requestId');
  });

  it('carries a payment identifier when one is in scope', () => {
    const lines = captureLogOutput((logger) => {
      runWithRequestContext({ requestId: 'req-abc', paymentId: 'pay_01K4QW' }, () => {
        logger.info({ event: 'payment.created' }, 'created');
      });
    });
    expect(lines.join('')).toContain('pay_01K4QW');
  });

  it('reports no context outside a request scope', () => {
    expect(currentRequestContext()).toBeUndefined();
  });

  it('restores the outer context after a nested scope ends', () => {
    runWithRequestContext({ requestId: 'outer' }, () => {
      runWithRequestContext({ requestId: 'inner' }, () => {
        expect(currentRequestContext()?.requestId).toBe('inner');
      });
      expect(currentRequestContext()?.requestId).toBe('outer');
    });
  });
});

/**
 * The leak that made this necessary: an RPC provider puts the API key in the URL path, a failing
 * endpoint raises an error carrying that URL in three separate fields, and the worker logs the whole
 * error on every failed tick. A key in a log aggregator is a key held by everyone who can read logs,
 * which in any real deployment is a much wider group than everyone who can read the environment.
 */
describe('errors that carry a provider URL', () => {
  it('keeps the host and drops everything that authenticates', () => {
    expect(redactUrls('https://polygon-mainnet.g.alchemy.com/v2/SECRETKEY123')).toBe(
      'https://polygon-mainnet.g.alchemy.com/[redacted]',
    );
  });

  it('leaves a bare origin alone, because there is nothing in it to leak', () => {
    expect(redactUrls('https://polygon-bor-rpc.publicnode.com')).toBe(
      'https://polygon-bor-rpc.publicnode.com',
    );
  });

  it('drops a key passed as a query parameter', () => {
    expect(redactUrls('https://rpc.example.com/?apiKey=SECRETKEY123')).toBe(
      'https://rpc.example.com/[redacted]',
    );
  });

  it('redacts every URL in a sentence, not only the first', () => {
    const redacted = redactUrls(
      'tried https://one.example.com/v2/AAA then https://two.example.com/v2/BBB',
    );
    expect(redacted).not.toContain('AAA');
    expect(redacted).not.toContain('BBB');
    expect(redacted).toContain('one.example.com');
    expect(redacted).toContain('two.example.com');
  });

  it('writes no provider key when a real viem transport error is logged', () => {
    const written = captureLogOutput((logger) => {
      logger.error(
        {
          error: new HttpRequestError({
            url: 'https://polygon-mainnet.g.alchemy.com/v2/SECRETKEY123',
            status: 429,
            details: 'rate limited',
          }),
          network: 'polygon-mainnet',
        },
        'The network tick failed',
      );
    });

    const line = written.join('');
    expect(line).not.toContain('SECRETKEY123');
    // The host survives, because "this provider is rate limiting us" is the point of the line.
    expect(line).toContain('alchemy.com');
    expect(line).toContain('polygon-mainnet');
  });

  it('never renders the fields viem hangs credentials on', () => {
    const written = captureLogOutput((logger) => {
      logger.error(
        {
          error: new HttpRequestError({
            url: 'https://rpc.example.com/v2/SECRETKEY123',
            status: 500,
            body: { method: 'eth_getLogs' },
          }),
        },
        'failed',
      );
    });

    const parsed = JSON.parse(written.join('')) as { error: Record<string, unknown> };
    const fields = Object.keys(parsed.error).toSorted((left, right) => left.localeCompare(right));
    expect(fields).toStrictEqual(['message', 'name', 'stack']);
  });
});

describe('a secret nested deeper than one level', () => {
  it('redacts a seed two levels down', () => {
    const written = captureLogOutput((logger) => {
      logger.info({ envelope: { wallet: { seed: 'a-plaintext-seed-value' } } }, 'provisioned');
    });

    expect(written.join('')).not.toContain('a-plaintext-seed-value');
  });
});
