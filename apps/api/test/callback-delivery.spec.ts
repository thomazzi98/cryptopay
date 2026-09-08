import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifyWebhook } from '@cryptopay/shared/server';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { DeliverCallbacksUseCase } from '../src/application/deliver-callbacks.use-case.js';
import { TEST_RETRY_POLICY } from '../src/domain/webhook-retry.js';
import { resolveSystemAddresses } from '../src/infrastructure/callbacks/address-resolver.js';
import { sendCallback } from '../src/infrastructure/callbacks/callback-transport.js';
import { WebhookDeliveryRepository } from '../src/infrastructure/persistence/webhook-delivery.repository.js';
import { WebhookSecretRepository } from '../src/infrastructure/persistence/webhook-secret.repository.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Callback delivery against a real HTTP receiver, over a real socket.
 *
 * A stubbed transport would prove the code calls itself correctly and nothing about whether a
 * merchant can verify what arrives. Here the bytes go over a socket, the signature is checked with
 * the same verifier a merchant would install, and the destination policy is the real one.
 */

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const PAYMENT_ID = 'pay_01K4QW6ZR2M8X4T7YQ0C3D8001';

interface ReceivedRequest {
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

let pool: Pool;
let dropDatabase: () => Promise<void>;
let receiver: Server;
let receiverPort = 0;
let received: ReceivedRequest[] = [];
let respondWith = { status: 200, body: 'ok', headers: {} as Record<string, string> };
let signingSecret = '';
let deliveryCounter = 0;

function receiverUrl(path = '/callbacks'): string {
  return `http://localhost:${receiverPort.toString()}${path}`;
}

function delivererFor(
  allowlist: readonly string[],
  nowValue = new Date(),
): DeliverCallbacksUseCase {
  return new DeliverCallbacksUseCase({
    webhookDeliveryRepository: new WebhookDeliveryRepository(pool),
    webhookSecretRepository: new WebhookSecretRepository(pool),
    transport: sendCallback,
    resolveAddresses: resolveSystemAddresses,
    retryPolicy: TEST_RETRY_POLICY,
    privateDestinationAllowlist: allowlist,
    allowlistIsPermittedByDeployment: true,
    workerIdentity: 'callback-worker-a',
    now: () => nowValue,
    randomFraction: () => 0.5,
    requestTimeoutMilliseconds: 3000,
  });
}

async function enqueue(destinationUrl: string, eventType = 'payment.completed'): Promise<string> {
  deliveryCounter += 1;
  const identifier = `whd_01K4QW6ZR2M8X4T7YQ0C3D8${deliveryCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO webhook_deliveries
       (id, merchant_id, payment_id, environment, event_type, destination_url, payload)
     VALUES ($1,$2,$3,'test',$4,$5,$6)`,
    [
      identifier,
      MERCHANT_ID,
      PAYMENT_ID,
      eventType,
      destinationUrl,
      JSON.stringify({ identifier, type: eventType, data: { id: PAYMENT_ID } }),
    ],
  );
  return identifier;
}

async function statusOf(identifier: string): Promise<string> {
  const delivery = await readDelivery(identifier);
  return delivery.status;
}

async function readDelivery(identifier: string) {
  const result = await pool.query<{
    status: string;
    attempt_count: number;
    next_attempt_at: Date;
    last_failure: string | null;
  }>(
    'SELECT status, attempt_count, next_attempt_at, last_failure FROM webhook_deliveries WHERE id = $1',
    [identifier],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No delivery ${identifier}`);
  }
  return row;
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    received.push({
      headers: request.headers as Record<string, string | undefined>,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(respondWith.status, {
      'content-type': 'text/plain',
      ...respondWith.headers,
    });
    response.end(respondWith.body);
  });
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'callbacks');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Callback Fixtures')`, [
    MERCHANT_ID,
  ]);
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 1000, '0xabc', 20)`,
  );
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, callback_url
     ) VALUES ($1,$2,'test','polygon-amoy',$1,
               '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582','USDC',6,
               25000000,25000000,25000000,
               '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d','pending',5,true,1000,
               now() + interval '30 minutes', 'https://hooks.merchant.example/cryptopay')`,
    [PAYMENT_ID, MERCHANT_ID],
  );

  signingSecret = await new WebhookSecretRepository(pool).issue(
    'whs_01K4QW6ZR2M8X4T7YQ0C3D5B9N',
    MERCHANT_ID,
    'test',
  );

  receiver = createServer(handleRequest);
  // Bound on every interface rather than on 127.0.0.1 alone: `localhost` resolves to ::1 first on a
  // dual-stack host, and the policy pins whichever address the resolver actually returned.
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  receiverPort = (receiver.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await dropDatabase();
});

beforeEach(async () => {
  received = [];
  respondWith = { status: 200, body: 'ok', headers: {} };
  await pool.query('DELETE FROM webhook_deliveries');
});

describe('delivering a callback', () => {
  it('reaches the merchant endpoint over a real socket', async () => {
    const identifier = await enqueue(receiverUrl());
    const outcome = await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    expect(outcome).toMatchObject({ claimed: 1, delivered: 1 });
    expect(received).toHaveLength(1);
    expect(await statusOf(identifier)).toBe('delivered');
  });

  /**
   * The test that decides whether a merchant can integrate at all. It uses the same verifier they
   * would install, against the bytes that actually arrived.
   */
  it('sends a signature the merchant can verify', async () => {
    await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    const request = received[0];
    expect(request).toBeDefined();
    const verification = verifyWebhook({
      headers: request?.headers ?? {},
      body: request?.body ?? '',
      secrets: [signingSecret],
    });
    expect(verification).toEqual({ kind: 'valid' });
  });

  it('transmits the stored body byte for byte', async () => {
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    const stored = await pool.query<{ payload: string }>(
      'SELECT payload FROM webhook_deliveries WHERE id = $1',
      [identifier],
    );
    expect(received[0]?.body).toBe(stored.rows[0]?.payload);
  });

  it('sends the delivery identifier as the webhook id', async () => {
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    expect(received[0]?.headers['webhook-id']).toBe(identifier);
  });

  it('records the address it actually connected to', async () => {
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    const attempts = await new WebhookDeliveryRepository(pool).attemptsFor(identifier);
    expect(attempts[0]).toMatchObject({ outcome: 'delivered', responseStatus: 200 });
    expect(attempts[0]?.resolvedAddress).not.toBeNull();
  });

  /**
   * Surfaced on the attempt row rather than silently applied, so a development convenience can never
   * be quietly in effect somewhere it should not be.
   */
  it('marks an attempt that only succeeded because of the allowlist', async () => {
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    const attempts = await new WebhookDeliveryRepository(pool).attemptsFor(identifier);
    expect(attempts[0]?.usedPrivateAllowlist).toBe(true);
  });
});

describe('an endpoint that fails', () => {
  it('schedules a retry and records why', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const outcome = await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    expect(outcome).toMatchObject({ retrying: 1 });
    const delivery = await readDelivery(identifier);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(1);
    expect(delivery.last_failure).toContain('500');
  });

  it('keeps the response so support can answer what the endpoint said', async () => {
    respondWith = { status: 503, body: 'upstream unavailable', headers: {} };
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    const attempts = await new WebhookDeliveryRepository(pool).attemptsFor(identifier);
    expect(attempts[0]?.responseSnippet).toContain('upstream unavailable');
  });

  /**
   * Never followed. Following a redirect lets anyone who can influence a merchant's DNS or hosting
   * bounce a signed request carrying payment data to an address the policy already refused.
   */
  it('treats a redirect as permanent rather than chasing it', async () => {
    respondWith = { status: 302, body: '', headers: { location: 'https://elsewhere.example/' } };
    const identifier = await enqueue(receiverUrl());
    const outcome = await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    expect(outcome).toMatchObject({ abandoned: 1 });
    expect(await statusOf(identifier)).toBe('abandoned');
    // One request, to the original destination. Nothing followed the Location header.
    expect(received).toHaveLength(1);
  });

  it('honours a Retry-After longer than the schedule', async () => {
    const at = new Date('2026-09-07T12:00:00.000Z');
    respondWith = { status: 429, body: 'slow down', headers: { 'retry-after': '300' } };
    const identifier = await enqueue(receiverUrl());
    await delivererFor([`localhost:${receiverPort.toString()}`], at).execute();

    const delivery = await readDelivery(identifier);
    expect(delivery.next_attempt_at.getTime()).toBe(at.getTime() + 300_000);
  });

  it('gives up once the schedule is spent', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const deliverer = delivererFor([`localhost:${receiverPort.toString()}`]);

    for (let attempt = 0; attempt <= TEST_RETRY_POLICY.delaysInSeconds.length; attempt += 1) {
      await pool.query(
        `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`,
        [identifier],
      );
      await deliverer.execute();
    }

    expect(await statusOf(identifier)).toBe('abandoned');
  });
});

describe('a destination the policy refuses', () => {
  it.each([
    ['https://169.254.169.254/hook', 'the cloud metadata service'],
    ['http://hooks.merchant.example/hook', 'plain http'],
    ['https://merchant.example:8443/hook', 'a port other than 443'],
  ])('never sends to %s (%s)', async (destination) => {
    const identifier = await enqueue(destination);
    const outcome = await delivererFor([]).execute();

    expect(outcome).toMatchObject({ blocked: 1, delivered: 0 });
    expect(received).toHaveLength(0);
    expect(await statusOf(identifier)).toBe('abandoned');
  });

  /**
   * A refusal is recorded rather than swallowed. A merchant whose callbacks silently stop has no way
   * to find out why, and the same row is what a probe against the policy looks like from the inside.
   */
  it('records the refusal so a merchant can be told what to fix', async () => {
    const identifier = await enqueue('https://169.254.169.254/hook');
    await delivererFor([]).execute();

    const attempts = await new WebhookDeliveryRepository(pool).attemptsFor(identifier);
    expect(attempts[0]?.outcome).toBe('blocked');
    // Refused at the parser, before anything is resolved: a bare address is never a merchant
    // endpoint, so the metadata service is turned away one layer earlier than its address would.
    expect(attempts[0]?.failureReason).toContain('hostname, not an address');
  });

  it('does nothing for a destination the deployment has not allowlisted', async () => {
    const identifier = await enqueue(receiverUrl());
    const outcome = await delivererFor([]).execute();

    expect(outcome).toMatchObject({ blocked: 1 });
    expect(received).toHaveLength(0);
    expect(await statusOf(identifier)).toBe('abandoned');
  });
});

describe('redelivering on an operator instruction', () => {
  /**
   * The merchant's idempotency key must not change. A redelivery is the same event again, not a new
   * one, and a merchant who did process the original has to be able to tell.
   */
  it('keeps the same webhook id', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    await delivererFor(allowlist).execute();

    respondWith = { status: 200, body: 'ok', headers: {} };
    const repository = new WebhookDeliveryRepository(pool);
    const requeued = await repository.requeue(identifier, MERCHANT_ID, new Date());
    expect(requeued?.identifier).toBe(identifier);

    await delivererFor(allowlist).execute();

    expect(received).toHaveLength(2);
    expect(received[0]?.headers['webhook-id']).toBe(received[1]?.headers['webhook-id']);
    expect(await statusOf(identifier)).toBe('delivered');
  });

  /**
   * The timestamp is the mirror of the rule above, and the one implementations get wrong. Reusing
   * the original would put every retry outside the verification window.
   */
  it('regenerates the timestamp, so a late redelivery still verifies', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    await delivererFor(allowlist, new Date('2026-09-07T12:00:00.000Z')).execute();

    respondWith = { status: 200, body: 'ok', headers: {} };
    await new WebhookDeliveryRepository(pool).requeue(identifier, MERCHANT_ID, new Date());
    const later = new Date('2026-09-09T12:00:00.000Z');
    await delivererFor(allowlist, later).execute();

    const retry = received[1];
    const expectedTimestamp = Math.floor(later.getTime() / 1000);
    expect(retry?.headers['webhook-timestamp']).toBe(expectedTimestamp.toString());
    const verification = verifyWebhook({
      headers: retry?.headers ?? {},
      body: retry?.body ?? '',
      secrets: [signingSecret],
      now: expectedTimestamp,
    });
    expect(verification).toEqual({ kind: 'valid' });
  });

  it('refuses to requeue a delivery belonging to another merchant', async () => {
    const identifier = await enqueue(receiverUrl());
    const repository = new WebhookDeliveryRepository(pool);
    expect(await repository.requeue(identifier, 'mch_someone_else', new Date())).toBeNull();
  });
});

async function attemptsOf(identifier: string) {
  const result = await pool.query<{ attempt_number: number; outcome: string }>(
    `SELECT attempt_number, outcome FROM webhook_delivery_attempts
      WHERE delivery_id = $1 ORDER BY attempt_number`,
    [identifier],
  );
  return result.rows;
}

/**
 * What the merchant and the operator can see afterwards.
 *
 * A redelivery that sends the request and leaves no trace is worse than one that fails: the delivery
 * log is the only place either party can check what was sent, and a button that appears to do
 * nothing is a button people press repeatedly.
 */
describe('the record a redelivery leaves', () => {
  it('records the new attempt without overwriting the ones before it', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    await delivererFor(allowlist).execute();

    respondWith = { status: 200, body: 'ok', headers: {} };
    await new WebhookDeliveryRepository(pool).requeue(identifier, MERCHANT_ID, new Date());
    await delivererFor(allowlist).execute();

    expect(await attemptsOf(identifier)).toStrictEqual([
      { attempt_number: 1, outcome: 'retryable' },
      { attempt_number: 2, outcome: 'delivered' },
    ]);
  });

  /**
   * The age ceiling is measured from the start of the current cycle, not from the event. Measuring
   * from the event would abandon a redelivery of anything older than the ceiling on its first
   * attempt, which is exactly when a merchant most wants one.
   */
  it('delivers a redelivery of an event older than the retry ceiling', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    await delivererFor(allowlist).execute();

    await pool.query(
      `UPDATE webhook_deliveries
          SET created_at = now() - interval '30 days', cycle_started_at = now() - interval '30 days'
        WHERE id = $1`,
      [identifier],
    );

    respondWith = { status: 200, body: 'ok', headers: {} };
    await new WebhookDeliveryRepository(pool).requeue(identifier, MERCHANT_ID, new Date());
    await delivererFor(allowlist).execute();

    expect(await statusOf(identifier)).toBe('delivered');
  });

  it('gives the redelivery the whole schedule again', async () => {
    respondWith = { status: 500, body: 'boom', headers: {} };
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    // One past the schedule, which is where it abandons: the last scheduled delay is spent by the
    // attempt after it.
    for (let attempt = 0; attempt <= TEST_RETRY_POLICY.delaysInSeconds.length; attempt += 1) {
      await pool.query(
        `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now() WHERE id = $1`,
        [identifier],
      );
      await delivererFor(allowlist).execute();
    }
    expect(await statusOf(identifier)).toBe('abandoned');

    await new WebhookDeliveryRepository(pool).requeue(identifier, MERCHANT_ID, new Date());
    await delivererFor(allowlist).execute();

    const delivery = await readDelivery(identifier);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(TEST_RETRY_POLICY.delaysInSeconds.length + 2);
  });
});

/**
 * A merchant with no active signing secret is an operator-side condition, not a refused destination.
 * Abandoning would throw the event away for a cause that is fixed in seconds, so it is retried and
 * the reason is recorded where both sides can read it.
 */
describe('a merchant with no signing secret', () => {
  beforeEach(async () => {
    await pool.query('UPDATE webhook_secrets SET retired_at = now() WHERE merchant_id = $1', [
      MERCHANT_ID,
    ]);
  });

  afterAll(async () => {
    await pool.query('UPDATE webhook_secrets SET retired_at = NULL WHERE merchant_id = $1', [
      MERCHANT_ID,
    ]);
  });

  it('schedules another attempt instead of abandoning the event', async () => {
    const identifier = await enqueue(receiverUrl());
    const outcome = await delivererFor([`localhost:${receiverPort.toString()}`]).execute();

    expect(outcome).toMatchObject({ claimed: 1, delivered: 0, retrying: 1, abandoned: 0 });
    const delivery = await readDelivery(identifier);
    expect(delivery.status).toBe('failed');
    expect(delivery.last_failure).toBe('the merchant has no active signing secret');
    expect(received).toHaveLength(0);
  });

  it('delivers once a secret exists again, with no operator action on the delivery', async () => {
    const identifier = await enqueue(receiverUrl());
    const allowlist = [`localhost:${receiverPort.toString()}`];
    await delivererFor(allowlist).execute();

    await pool.query('UPDATE webhook_secrets SET retired_at = NULL WHERE merchant_id = $1', [
      MERCHANT_ID,
    ]);
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now() WHERE id = $1`,
      [identifier],
    );
    await delivererFor(allowlist).execute();

    expect(await statusOf(identifier)).toBe('delivered');
    expect(received).toHaveLength(1);
  });
});
