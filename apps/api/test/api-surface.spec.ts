import type { Environment } from '@cryptopay/shared';
import { generateSigningSecret } from '@cryptopay/shared/server';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * The read and repair surface a merchant actually uses: what happened to a payment, what was sent
 * about it, and how to send it again.
 *
 * Redelivery is the reason most of this exists. A merchant whose receiver was down while an event
 * was sent has no way to recover it otherwise, and telling them to reconcile by polling is telling
 * them to build the notification system themselves.
 */

const PEPPER = 'p'.repeat(48);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3E1001';
const OTHER_MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3E1002';
const PAYMENT_ID = 'pay_01K4QW6ZR2M8X4T7YQ0C3E1001';
const OTHER_PAYMENT_ID = 'pay_01K4QW6ZR2M8X4T7YQ0C3E1002';
const DELIVERY_ID = 'whd_01K4QW6ZR2M8X4T7YQ0C3E1001';
const ACCOUNT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const OTHER_ACCOUNT = '0x8c2b5f7d0e1a3b4c6d8e9f01a2b3c4d5e6f70b1c';
const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';
/** Assembled rather than written, so this file holds no literal that matches a credential pattern. */
const SECRET_PREFIX = `whsec_`;

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let testKey = '';
let otherMerchantKey = '';

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;

async function issueKey(merchantId: string, environment: Environment): Promise<string> {
  keyCounter += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, keyCounter);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'surface')`,
    [generated.keyIdentifier, merchantId, environment, generated.secretDigest, generated.lastFour],
  );
  return generated.presentedKey;
}

function get(url: string, key = testKey) {
  return server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

function post(url: string, key = testKey) {
  return server.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` } });
}

async function insertPayment(id: string, merchantId: string, account: string): Promise<void> {
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, callback_url
     ) VALUES ($1,$2,'test','polygon-amoy',$1,$3,'USDC',6,
               25000000,25000000,25000000,$4,'confirming',5,true,1000,
               now() + interval '30 minutes', 'https://hooks.merchant.example/cryptopay')`,
    [id, merchantId, USDC_AMOY, account],
  );
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'surface');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)', [
    MERCHANT_ID,
    'Surface Fixtures',
    OTHER_MERCHANT_ID,
    'Someone Else',
  ]);
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 46903512, '0xabc', 20)`,
  );

  await insertPayment(PAYMENT_ID, MERCHANT_ID, ACCOUNT);
  await insertPayment(OTHER_PAYMENT_ID, OTHER_MERCHANT_ID, OTHER_ACCOUNT);

  await pool.query(
    `INSERT INTO payment_transfers
       (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
        block_reference, source_account, asset_reference, amount, classification, observation,
        orphaned_at)
     VALUES ('trf_01K4QW6ZR2M8X4T7YQ0C3E1001',$1,'polygon-amoy',$2,0,46903512,$3,$4,$5,
             25000000,'credited','observed',NULL),
            ('trf_01K4QW6ZR2M8X4T7YQ0C3E1002',$1,'polygon-amoy',$6,0,46903400,$3,$4,$5,
             9000000,'credited','orphaned',now())`,
    [
      PAYMENT_ID,
      `0x${'a'.repeat(64)}`,
      `0x${'b'.repeat(64)}`,
      OTHER_ACCOUNT,
      USDC_AMOY,
      `0x${'c'.repeat(64)}`,
    ],
  );

  await pool.query(
    `INSERT INTO payment_status_transitions
       (payment_id, from_status, to_status, from_version, to_version, command, caused_by,
        credited_amount, confirmations)
     VALUES ($1,'pending','confirming',0,1,'applyLedgerObservation','TRANSFER_CREDITED',25000000,1)`,
    [PAYMENT_ID],
  );

  // Generated rather than written down: a credential-shaped literal in source cannot be told apart
  // from a real one by a reviewer or by a scanner, whatever the value actually is.
  await pool.query(
    `INSERT INTO webhook_secrets (id, merchant_id, environment, secret) VALUES ($1,$2,'test',$3)`,
    ['whs_01K4QW6ZR2M8X4T7YQ0C3E1001', MERCHANT_ID, generateSigningSecret()],
  );

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);

  testKey = await issueKey(MERCHANT_ID, 'test');
  otherMerchantKey = await issueKey(OTHER_MERCHANT_ID, 'test');
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_delivery_attempts');
  await pool.query('DELETE FROM webhook_deliveries');
  await pool.query(
    `INSERT INTO webhook_deliveries
       (id, merchant_id, payment_id, environment, event_type, destination_url, payload, status,
        attempt_count, next_attempt_at, last_failure)
     VALUES ($1,$2,$3,'test','payment.confirming','https://hooks.merchant.example/cryptopay',
             '{"type":"payment.confirming"}','failed',2,now() + interval '5 minutes',
             'the destination answered 503')`,
    [DELIVERY_ID, MERCHANT_ID, PAYMENT_ID],
  );
  await pool.query(
    `INSERT INTO webhook_delivery_attempts
       (delivery_id, attempt_number, outcome, response_status, resolved_address, response_snippet,
        duration_milliseconds, failure_reason, used_private_allowlist)
     VALUES ($1,1,'retryable',503,'93.184.216.34','upstream unavailable',120,
             'the destination answered 503',false)`,
    [DELIVERY_ID],
  );
  await pool.query(
    `UPDATE block_cursors
        SET halted_at = NULL, halted_reason = NULL, updated_at = now(),
            finalized_advanced_at = NULL
      WHERE network_identifier = 'polygon-amoy'`,
  );
});

describe('readiness against a real database', () => {
  it('reports every watched network and the block it reached', async () => {
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      components: { name: string; status: string; detail: string }[];
    }>();
    expect(body.status).toBe('ok');
    const network = body.components.find((entry) => entry.name === 'network:polygon-amoy');
    expect(network?.status).toBe('ok');
    expect(network?.detail).toContain('46903512');
  });

  /**
   * Degraded rather than failed. The API can still answer, and taking every instance out of rotation
   * because one chain stopped turns a contained incident into an outage.
   */
  it('reports a halted network as degraded while still serving traffic', async () => {
    await pool.query(
      `UPDATE block_cursors SET halted_at = now(), halted_reason = 'reorg deeper than the limit'
        WHERE network_identifier = 'polygon-amoy'`,
    );
    const response = await server.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      components: { name: string; detail: string }[];
    }>();
    expect(body.status).toBe('degraded');
    expect(
      body.components.find((entry) => entry.name === 'network:polygon-amoy')?.detail,
    ).toContain('reorg deeper than the limit');
  });

  /**
   * The failure that is otherwise invisible: payments keep being created and customers keep paying
   * while nothing is detected, with every other signal green.
   */
  it('reports a cursor that has stopped advancing', async () => {
    await pool.query(
      `UPDATE block_cursors SET updated_at = now() - interval '10 minutes'
        WHERE network_identifier = 'polygon-amoy'`,
    );
    const response = await server.inject({ method: 'GET', url: '/readyz' });

    const body = response.json<{
      status: string;
      components: { name: string; detail: string }[];
    }>();
    expect(body.status).toBe('degraded');
    expect(
      body.components.find((entry) => entry.name === 'network:polygon-amoy')?.detail,
    ).toContain('has not advanced');
  });

  /**
   * The stall a confirmation count cannot see. Blocks keep arriving and confirmations climb while
   * nothing finalizes, so the gate holds and every payment waiting on finality quietly stops
   * completing. Holding is the right answer; being silent about it is not.
   */
  it('reports a finality view that has stopped moving', async () => {
    await pool.query(
      `UPDATE block_cursors SET finalized_advanced_at = now() - interval '30 minutes'
        WHERE network_identifier = 'polygon-amoy'`,
    );
    const response = await server.inject({ method: 'GET', url: '/readyz' });

    const body = response.json<{
      status: string;
      components: { name: string; detail: string }[];
    }>();
    expect(body.status).toBe('degraded');
    expect(
      body.components.find((entry) => entry.name === 'network:polygon-amoy')?.detail,
    ).toContain('finalized height has not moved');
  });

  /** The counterexample: a finality view that moved recently is not reported at all. */
  it('says nothing about a finality view that is still moving', async () => {
    await pool.query(
      `UPDATE block_cursors SET finalized_advanced_at = now() - interval '1 minute'
        WHERE network_identifier = 'polygon-amoy'`,
    );
    const response = await server.inject({ method: 'GET', url: '/readyz' });

    const body = response.json<{
      status: string;
      components: { name: string; status: string }[];
    }>();
    expect(body.status).toBe('ok');
    expect(body.components.find((entry) => entry.name === 'network:polygon-amoy')?.status).toBe(
      'ok',
    );
  });
});

describe('what happened to a payment', () => {
  /**
   * Orphaned transfers are reported, never filtered. A customer whose money was withdrawn by a reorg
   * needs it to be visible, and a list that quietly omits it leaves support with nothing to say.
   */
  it('lists every transfer including the ones a reorg withdrew', async () => {
    const response = await get(`/v1/payments/${PAYMENT_ID}/transfers`);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      data: { observation: string; amount: { baseUnits: string }; explorerUrl: string | null }[];
    }>();
    expect(body.data).toHaveLength(2);
    expect(
      body.data
        .map((transfer) => transfer.observation)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['observed', 'orphaned']);
    expect(body.data[0]?.explorerUrl).toContain('amoy.polygonscan.com');
  });

  /**
   * A chain that names no sender must publish none. The adapter used to fill this field with the
   * account that was credited, which put the merchant's own deposit address under a heading that
   * reads "From" and named it as the payer. Null is the honest answer and the contract admits it.
   */
  it('publishes no source account for a transfer whose chain names no sender', async () => {
    await pool.query(
      `INSERT INTO payment_transfers
         (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
          block_reference, source_account, asset_reference, amount, classification, observation)
       VALUES ('trf_01K4QW6ZR2M8X4T7YQ0C3E1003',$1,'polygon-amoy',$2,0,46903513,$3,NULL,$4,
               1000000,'credited','observed')`,
      [PAYMENT_ID, `0x${'d'.repeat(64)}`, `0x${'b'.repeat(64)}`, USDC_AMOY],
    );

    try {
      const response = await get(`/v1/payments/${PAYMENT_ID}/transfers`);
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        data: { transactionReference: string; sourceAccount: string | null }[];
      }>();
      const unattributed = body.data.find(
        (transfer) => transfer.transactionReference === `0x${'d'.repeat(64)}`,
      );
      expect(unattributed).toBeDefined();
      expect(unattributed?.sourceAccount).toBeNull();
      // The counterexample in the same response: where the chain does name a sender, it is published.
      expect(
        body.data.filter((transfer) => transfer.sourceAccount !== null).length,
      ).toBeGreaterThan(0);
    } finally {
      await pool.query(`DELETE FROM payment_transfers WHERE id = 'trf_01K4QW6ZR2M8X4T7YQ0C3E1003'`);
    }
  });

  it('reports amounts as base units and a display string, never as a number', async () => {
    const response = await get(`/v1/payments/${PAYMENT_ID}/transfers`);
    const body = response.json<{ data: { amount: { baseUnits: string; display: string } }[] }>();
    const amounts = body.data.map((transfer) => transfer.amount);
    expect(amounts).toContainEqual({ baseUnits: '25000000', display: '25.000000' });
    for (const amount of amounts) {
      expect(typeof amount.baseUnits).toBe('string');
    }
  });

  it('returns the audit trail as it was written', async () => {
    const response = await get(`/v1/payments/${PAYMENT_ID}/timeline`);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      data: { fromStatus: string; toStatus: string; trigger: string; statusVersion: number }[];
    }>();
    expect(body.data).toEqual([
      {
        fromStatus: 'pending',
        toStatus: 'confirming',
        trigger: 'TRANSFER_CREDITED',
        statusVersion: 1,
        occurredAt: expect.any(String) as unknown as string,
      },
    ]);
  });

  it('lists the callbacks sent about it', async () => {
    const response = await get(`/v1/payments/${PAYMENT_ID}/deliveries`);
    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: { identifier: string; status: string }[] }>();
    expect(body.data).toEqual([
      expect.objectContaining({ identifier: DELIVERY_ID, status: 'failed' }) as unknown as {
        identifier: string;
        status: string;
      },
    ]);
  });

  /**
   * Another merchant's payment answers 404 rather than 403. A 403 confirms the identifier exists,
   * which is all an enumeration attack needs.
   */
  it.each(['transfers', 'timeline', 'deliveries'])(
    'answers 404 for another merchant asking for %s',
    async (subResource) => {
      const response = await get(`/v1/payments/${PAYMENT_ID}/${subResource}`, otherMerchantKey);
      expect(response.statusCode).toBe(404);
    },
  );
});

describe('inspecting callbacks', () => {
  it('lists deliveries for this merchant only', async () => {
    const response = await get('/v1/webhooks/deliveries');
    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: { identifier: string }[]; hasMore: boolean }>();
    expect(body.data.map((delivery) => delivery.identifier)).toEqual([DELIVERY_ID]);
    expect(body.hasMore).toBe(false);
  });

  it('filters by status', async () => {
    const delivered = await get('/v1/webhooks/deliveries?status=delivered');
    expect(delivered.json<{ data: unknown[] }>().data).toHaveLength(0);

    const failed = await get('/v1/webhooks/deliveries?status=failed');
    expect(failed.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it('refuses a status that is not one this system uses', async () => {
    const response = await get('/v1/webhooks/deliveries?status=exploded');
    expect(response.statusCode).toBe(422);
  });

  /**
   * The attempt detail is what support answers questions from: what the endpoint said, how long it
   * took, and which address the request was actually pinned to.
   */
  it('returns every attempt with the address it connected to', async () => {
    const response = await get(`/v1/webhooks/deliveries/${DELIVERY_ID}`);
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      attempts: { attemptNumber: number; responseStatus: number; resolvedAddress: string }[];
      nextAttemptAt: string | null;
    }>();
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({
      attemptNumber: 1,
      responseStatus: 503,
      resolvedAddress: '93.184.216.34',
    });
    expect(body.nextAttemptAt).not.toBeNull();
  });

  it('answers 404 for another merchant', async () => {
    const response = await get(`/v1/webhooks/deliveries/${DELIVERY_ID}`, otherMerchantKey);
    expect(response.statusCode).toBe(404);
  });
});

describe('sending a callback again', () => {
  it('queues it and reports the delivery as pending', async () => {
    const response = await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string }>().status).toBe('pending');
  });

  /**
   * The merchant's idempotency key must survive. A redelivery is the same event again, not a new
   * one, and a merchant who did process the original has to be able to tell.
   */
  it('keeps the same identifier, which is the webhook id they already stored', async () => {
    const response = await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    expect(response.json<{ identifier: string }>().identifier).toBe(DELIVERY_ID);
  });

  /**
   * The schedule starts again without the attempt count being rewound. Rewinding it made the next
   * attempt reuse an attempt number that already existed, and the attempt insert is
   * ON CONFLICT DO NOTHING for crash safety, so the redelivery left no trace at all.
   */
  it('starts the schedule again while keeping the attempts already made', async () => {
    await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    const stored = await pool.query<{ attempt_count: number; schedule_offset: number }>(
      'SELECT attempt_count, schedule_offset FROM webhook_deliveries WHERE id = $1',
      [DELIVERY_ID],
    );
    const row = stored.rows[0];
    expect(row?.attempt_count).toBe(row?.schedule_offset);
  });

  it('measures the retry ceiling from the redelivery rather than from the original event', async () => {
    await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    const stored = await pool.query<{ started_after_creation: boolean }>(
      `SELECT cycle_started_at > created_at AS started_after_creation
         FROM webhook_deliveries WHERE id = $1`,
      [DELIVERY_ID],
    );
    expect(stored.rows[0]?.started_after_creation).toBe(true);
  });

  it('keeps the attempts already recorded, because the history is the point', async () => {
    await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    const response = await get(`/v1/webhooks/deliveries/${DELIVERY_ID}`);
    expect(response.json<{ attempts: unknown[] }>().attempts).toHaveLength(1);
  });

  /**
   * Permitted for a delivery that already succeeded, not only a failed one. A merchant who lost the
   * event on their side knows better than we do whether they need it again.
   */
  it('sends a delivered callback again when the merchant asks', async () => {
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now() WHERE id = $1`,
      [DELIVERY_ID],
    );
    const response = await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    expect(response.statusCode).toBe(202);
  });

  it('refuses while an attempt is in flight rather than racing it', async () => {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status = 'in_flight', claimed_by = 'worker-a', claim_expires_at = now() + interval '1 minute'
        WHERE id = $1`,
      [DELIVERY_ID],
    );
    const response = await post(`/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`);
    expect(response.statusCode).toBe(422);
  });

  it('answers 404 for another merchant, and changes nothing', async () => {
    const response = await post(
      `/v1/webhooks/deliveries/${DELIVERY_ID}/redeliver`,
      otherMerchantKey,
    );
    expect(response.statusCode).toBe(404);

    const stored = await pool.query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE id = $1',
      [DELIVERY_ID],
    );
    expect(stored.rows[0]?.status).toBe('failed');
  });
});

describe('signing secrets', () => {
  /**
   * A value that can be read back from an API is a value that leaks through every log, proxy and
   * screen share that ever touches it. It is shown once, at creation, and never again.
   */
  it('never returns an existing secret, only a hint', async () => {
    const response = await get('/v1/webhooks/secrets');
    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: { secret: string | null; hint: string }[] }>();
    expect(body.data[0]?.secret).toBeNull();
    expect(body.data[0]?.hint).toContain(SECRET_PREFIX);
    expect(body.data[0]?.hint).toContain('...');
  });

  it('returns a new secret in full exactly once', async () => {
    const created = await post('/v1/webhooks/secrets');
    expect(created.statusCode).toBe(201);

    const secret = created.json<{ identifier: string; secret: string }>();
    expect(secret.secret.startsWith(SECRET_PREFIX)).toBe(true);

    const listed = await get('/v1/webhooks/secrets');
    const stored = listed
      .json<{ data: { identifier: string; secret: string | null }[] }>()
      .data.find((entry) => entry.identifier === secret.identifier);
    expect(stored?.secret).toBeNull();

    await server.inject({
      method: 'DELETE',
      url: `/v1/webhooks/secrets/${secret.identifier}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
  });

  /**
   * Rotation is by overlap. Both secrets sign until the old one is retired, so an endpoint that has
   * not been updated yet keeps verifying instead of breaking at the worst moment.
   */
  it('keeps both secrets active during a rotation', async () => {
    const created = await post('/v1/webhooks/secrets');
    const identifier = created.json<{ identifier: string }>().identifier;

    const listed = await get('/v1/webhooks/secrets');
    expect(listed.json<{ data: unknown[] }>().data.length).toBeGreaterThanOrEqual(2);

    await server.inject({
      method: 'DELETE',
      url: `/v1/webhooks/secrets/${identifier}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
  });

  /**
   * A merchant with no active secret would receive callbacks nobody can verify, which is worse than
   * a stale secret that still works.
   */
  it('refuses to retire the only secret a merchant has', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/v1/webhooks/secrets/whs_01K4QW6ZR2M8X4T7YQ0C3E1001',
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(response.statusCode).toBe(422);
  });

  /**
   * The status code alone proves nothing here. The test above shows the owner's own key is refused
   * on this same request with the same 422, because it is the merchant's only secret, so asserting
   * 422 for another merchant would pass whether isolation worked or not.
   *
   * The merchant is therefore given a second secret first, which makes the owner's request one that
   * would succeed, and what is asserted is the observable security property: the secret another
   * merchant asked to retire is still active afterwards.
   */
  it('refuses to retire a secret belonging to another merchant', async () => {
    const created = await post('/v1/webhooks/secrets');
    const ownSecond = created.json<{ identifier: string }>().identifier;
    const activeBefore = await get('/v1/webhooks/secrets');
    const countBefore = activeBefore.json<{ data: unknown[] }>().data.length;
    expect(countBefore).toBeGreaterThanOrEqual(2);

    const response = await server.inject({
      method: 'DELETE',
      url: '/v1/webhooks/secrets/whs_01K4QW6ZR2M8X4T7YQ0C3E1001',
      headers: { authorization: `Bearer ${otherMerchantKey}` },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const activeAfter = await get('/v1/webhooks/secrets');
    expect(activeAfter.json<{ data: unknown[] }>().data.length).toBe(countBefore);

    // Cleared up so the merchant is left as this suite found it.
    await server.inject({
      method: 'DELETE',
      url: `/v1/webhooks/secrets/${ownSecond}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
  });
});

/**
 * A merchant holds keys for both environments, so "belongs to this merchant" is not a sufficient
 * check for a destructive action. Retiring the secret a live receiver verifies with breaks live
 * callback verification, and it did so from a request made with a test key.
 */
describe('retiring a signing secret across environments', () => {
  it('refuses a live secret to a test key', async () => {
    const liveKey = await issueKey(MERCHANT_ID, 'live');
    // Row identifiers, not secret material, and named for what they hold. A variable whose name
    // says secret, bound to a high-entropy literal, is exactly what a credential scanner is built
    // to find; teaching the scanner to ignore it costs more than saying what the value is.
    const liveIdentifier = 'whs_01K4QW6ZR2M8X4T7YQ0C3E2001';
    const spareIdentifier = 'whs_01K4QW6ZR2M8X4T7YQ0C3E2002';
    for (const identifier of [liveIdentifier, spareIdentifier]) {
      await pool.query(
        `INSERT INTO webhook_secrets (id, merchant_id, environment, secret)
         VALUES ($1, $2, 'live', $3)`,
        [identifier, MERCHANT_ID, `${SECRET_PREFIX}${identifier}`],
      );
    }

    const refused = await server.inject({
      method: 'DELETE',
      url: `/v1/webhooks/secrets/${liveIdentifier}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(refused.statusCode).toBe(422);

    const stored = await pool.query<{ retired_at: Date | null }>(
      'SELECT retired_at FROM webhook_secrets WHERE id = $1',
      [liveIdentifier],
    );
    expect(stored.rows[0]?.retired_at).toBeNull();

    // The live key that owns it can still retire it, so the guard scopes rather than forbids.
    const allowed = await server.inject({
      method: 'DELETE',
      url: `/v1/webhooks/secrets/${liveIdentifier}`,
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(allowed.statusCode).toBe(204);
  });
});
