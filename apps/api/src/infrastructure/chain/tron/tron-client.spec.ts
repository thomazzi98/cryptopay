import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpTronNode, TronTransportError } from './tron-client.js';

/**
 * What the client does with a body that reports a failure while the status line says success.
 *
 * TronGrid answers HTTP 200 with an `Error` field when a request fails, and every read on this
 * client degrades an unrecognised body into a benign negative: no block at this height, no events in
 * this block, the chain does not know this transaction, the account holds nothing. Each is a
 * legitimate answer that the scanner and the reconciler act on, so an endpoint failing this way used
 * to become "there is no payment here" — a window scanned as empty with the cursor advanced past it,
 * or a credited transfer withdrawn as orphaned because the node that could confirm it was the one
 * that failed.
 */

let server: Server;
let baseUrl = '';
let answer: unknown = {};

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port.toString()}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function node(): HttpTronNode {
  return new HttpTronNode({ baseUrl, apiKey: null, timeoutMilliseconds: 5000 });
}

describe('an endpoint that fails while answering two hundred', () => {
  it.each([
    ['reading a block', async () => node().readBlock(100)],
    ['reading a block range', async () => node().readBlockRange(100, 101)],
    ['reading the events in a block', async () => node().readBlockEvents(100)],
    ['looking a transaction up', async () => node().readTransaction('a'.repeat(64))],
    [
      'reading a native balance',
      async () => node().readNativeBalance('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
    ],
    ['reading the head', async () => node().readHead()],
  ])('refuses rather than reporting nothing found when %s', async (_label, read) => {
    answer = { Error: 'class org.tron.core.exception.ItemNotFoundException : failed' };

    await expect(read()).rejects.toBeInstanceOf(TronTransportError);
  });

  /**
   * The distinction that has to survive the fix. A height above the head is a real answer and must
   * stay one, or the scanner would halt every time it caught up with the chain.
   */
  it('still reports no block for a height the chain has not reached', async () => {
    answer = {};

    await expect(node().readBlock(100)).resolves.toBeNull();
  });

  it('still reports an account that holds nothing', async () => {
    answer = {};

    await expect(node().readNativeBalance('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).resolves.toBe(0n);
  });

  it('still reports a transaction the chain genuinely does not carry', async () => {
    answer = {};

    await expect(node().readTransaction('a'.repeat(64))).resolves.toBeNull();
  });
});
