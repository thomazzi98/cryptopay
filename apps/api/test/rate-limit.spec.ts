import type { Environment, GatewayError } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * The request budget, on a server configured with a limit a test can actually reach.
 *
 * Its own spec rather than a section of the gateway suite, because a limit low enough to exercise
 * is a limit every other test in a shared suite would trip over. That is not a testing
 * inconvenience; it is the same property the feature exists for, observed from the wrong side.
 *
 * The point being asserted is that the counter is shared. An in-process token bucket enforces the
 * configured limit once per replica, so the real limit becomes the configured one multiplied by
 * however many instances happen to be running, and it changes when the deployment scales without
 * anybody editing a setting.
 */

const PEPPER = 'r'.repeat(48);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3L1001';
const LIMIT = 12;
const MISSING_PAYMENT = '/api/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3L9999';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;

async function issueKey(environment: Environment = 'test'): Promise<string> {
  keyCounter += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, keyCounter);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'budget')`,
    [generated.keyIdentifier, MERCHANT_ID, environment, generated.secretDigest, generated.lastFour],
  );
  return generated.presentedKey;
}

function get(key: string) {
  return server.inject({
    method: 'GET',
    url: MISSING_PAYMENT,
    headers: { authorization: `Bearer ${key}` },
  });
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'budget');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [
    MERCHANT_ID,
    'Budget Fixtures',
  ]);

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    API_RATE_LIMIT_REQUESTS: String(LIMIT),
    // Long enough that the window cannot roll over mid-test and make a refusal disappear.
    API_RATE_LIMIT_WINDOW_SECONDS: '300',
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

describe('spending a request budget', () => {
  it('answers on the merits up to the limit, and refuses after it', async () => {
    const key = await issueKey();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
      const response = await get(key);
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, LIMIT)).toEqual(Array.from({ length: LIMIT }, () => 404));
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
  });

  it('refuses in the gateway envelope and says when to try again', async () => {
    const key = await issueKey();
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await get(key);
    }
    const refused = await get(key);

    expect(refused.statusCode).toBe(429);
    expect(refused.json<GatewayError>().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(refused.headers['ratelimit-remaining']).toBe('0');
  });

  it('reports what is left while there is budget remaining', async () => {
    const key = await issueKey();
    const first = await get(key);
    expect(first.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });

  it('budgets each key separately, so one integration cannot starve another', async () => {
    const spent = await issueKey();
    const fresh = await issueKey();
    for (let attempt = 0; attempt < LIMIT + 1; attempt += 1) {
      await get(spent);
    }

    const exhausted = await get(spent);
    const untouched = await get(fresh);
    expect(exhausted.statusCode).toBe(429);
    expect(untouched.statusCode).toBe(404);
  });

  /**
   * The count is a row, not a variable in this process. That is what makes the limit hold across
   * every instance instead of once per instance.
   */
  it('keeps the count where every instance can see it', async () => {
    const key = await issueKey();
    await get(key);
    await get(key);

    const stored = await pool.query<{ request_count: number }>(
      `SELECT request_count FROM api_key_rate_windows ORDER BY window_started DESC LIMIT 1`,
    );
    expect(stored.rows[0]?.request_count).toBe(2);
  });

  /**
   * Counted only after the key is known to be valid. Otherwise an unauthenticated flood could spend
   * a real merchant's budget, using a counter keyed on something the attacker chose.
   */
  it('never counts an unauthenticated request against any key', async () => {
    const before = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(request_count), 0)::text AS total FROM api_key_rate_windows`,
    );
    const refused = await server.inject({
      method: 'GET',
      url: MISSING_PAYMENT,
      headers: { authorization: 'Bearer cp_test_not_a_real_key' },
    });
    const after = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(request_count), 0)::text AS total FROM api_key_rate_windows`,
    );

    expect(refused.statusCode).toBe(401);
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });

  it('does not budget the probes an orchestrator calls', async () => {
    const before = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(request_count), 0)::text AS total FROM api_key_rate_windows`,
    );
    for (const url of ['/health', '/readiness', '/healthz']) {
      await server.inject({ method: 'GET', url });
    }
    const after = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(request_count), 0)::text AS total FROM api_key_rate_windows`,
    );

    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });
});
