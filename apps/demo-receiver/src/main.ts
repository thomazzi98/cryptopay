import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { verifyWebhook } from '@cryptopay/shared/server';

/**
 * A merchant endpoint, as small as one can honestly be.
 *
 * It exists to prove interoperability rather than to assert it: it verifies with the same module the
 * API signs with, which is also the module a merchant would install from npm, so a passing signature
 * here means a passing signature on their server too.
 *
 * Three behaviours are deliberate and each corresponds to something the delivery worker must handle.
 * The raw body is verified as received and never re-serialized, because the signature covers those
 * bytes. A duplicate `webhook-id` is answered 200 without being processed twice, because at-least-
 * once delivery is the contract and deduplicating is the merchant's job. And a request that fails
 * verification is refused with 401 rather than quietly ignored, so a misconfiguration is visible
 * from both sides.
 */

const PORT = Number(process.env.PORT ?? '8080');
const SIGNING_SECRETS = (process.env.WEBHOOK_SIGNING_SECRETS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '');

const MAXIMUM_BODY_BYTES = 65_536;
const seenEventIdentifiers = new Set<string>();
const received: { identifier: string; type: string; at: string }[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) {
        reject(new Error('The request body is larger than this receiver accepts'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized).toString(),
  });
  response.end(serialized);
}

async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);

  if (SIGNING_SECRETS.length === 0) {
    // Refusing is the only honest answer. Accepting unverified callbacks would make this receiver a
    // demonstration of the wrong thing.
    reply(response, 503, {
      accepted: false,
      reason: 'This receiver has no signing secret configured, so it cannot verify anything.',
    });
    return;
  }

  const verification = verifyWebhook({
    headers: request.headers as Record<string, string | undefined>,
    // As received. Parsing and re-serializing reorders keys and the signature never matches again.
    body,
    secrets: SIGNING_SECRETS,
  });

  if (verification.kind === 'invalid') {
    reply(response, 401, { accepted: false, reason: verification.reason });
    return;
  }

  const identifier = request.headers['webhook-id'];
  if (typeof identifier !== 'string') {
    reply(response, 400, { accepted: false, reason: 'The webhook-id header is missing.' });
    return;
  }

  // At-least-once delivery is the contract, so the same event arriving twice is normal rather than
  // an error. Deduplicating on the id is the merchant's side of that bargain.
  if (seenEventIdentifiers.has(identifier)) {
    reply(response, 200, { accepted: true, duplicate: true });
    return;
  }

  seenEventIdentifiers.add(identifier);
  const event = JSON.parse(body) as { type?: string };
  received.unshift({
    identifier,
    type: event.type ?? 'unknown',
    at: new Date().toISOString(),
  });
  received.length = Math.min(received.length, 50);

  reply(response, 200, { accepted: true, duplicate: false });
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    reply(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && request.url === '/received') {
    reply(response, 200, { data: received });
    return;
  }
  if (request.method === 'POST' && request.url === '/callbacks') {
    void handleCallback(request, response).catch(() => {
      reply(response, 400, { accepted: false, reason: 'The request could not be read.' });
    });
    return;
  }
  reply(response, 404, { reason: 'No such endpoint on this receiver.' });
});

server.listen(PORT, () => {
  process.stdout.write(
    `Demo receiver listening on ${PORT.toString()}; POST /callbacks, GET /received\n`,
  );
});
