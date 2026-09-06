import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { loadConfiguration } from '../configuration.js';
import { createLogger, currentRequestContext, runWithRequestContext } from './logger.js';

function captureLogOutput(write: (logger: ReturnType<typeof createLogger>) => void): string[] {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });

  const configuration = loadConfiguration({ NODE_ENV: 'test', LOG_LEVEL: 'trace' });
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
