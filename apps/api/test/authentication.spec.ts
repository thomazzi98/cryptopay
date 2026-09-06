import type { Environment } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfiguration } from '../src/configuration.js';
import { buildServer } from '../src/http/build-server.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { MerchantRepository } from '../src/infrastructure/persistence/merchant.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Authentication end to end against a real database. Every rejection must be indistinguishable from
 * every other: an unauthenticated caller learning that a key identifier exists is a small leak that
 * makes a larger attack cheaper.
 */

const PEPPER = 'p'.repeat(48);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const OTHER_MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9P';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;

const ulidFactory = new UlidFactory();
let timeCursor = 1_757_183_400_000;

interface IssuedKey {
  readonly presentedKey: string;
  readonly keyIdentifier: string;
}

async function issueKey(
  merchantId: string,
  environment: Environment,
  options: { revoked?: boolean } = {},
): Promise<IssuedKey> {
  timeCursor += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, timeCursor);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label, revoked_at)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'test key', $6)`,
    [
      generated.keyIdentifier,
      merchantId,
      environment,
      generated.secretDigest,
      generated.lastFour,
      options.revoked === true ? new Date() : null,
    ],
  );
  return { presentedKey: generated.presentedKey, keyIdentifier: generated.keyIdentifier };
}

function withoutRequestId(body: string): string {
  return body.replaceAll(/"requestId":"[^"]+"/g, '"requestId":"<id>"');
}

function authenticatedRequest(key: string) {
  return server.inject({
    method: 'GET',
    url: '/v1/merchants/me',
    headers: { authorization: `Bearer ${key}` },
  });
}

beforeAll(async () => {
  const port = inject('postgresPort');
  const isolated = await createIsolatedDatabase(port, 'authentication');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)', [
    MERCHANT_ID,
    'Northwind Supplies',
    OTHER_MERCHANT_ID,
    'Someone Else',
  ]);

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, port),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  });
  server = buildServer({
    configuration,
    logger: pino({ level: 'silent' }),
    merchantRepository: new MerchantRepository(pool),
  });
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

describe('authenticating with a valid key', () => {
  it('returns the merchant the key belongs to', async () => {
    const key = await issueKey(MERCHANT_ID, 'test');
    const response = await authenticatedRequest(key.presentedKey);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ identifier: string; displayName: string }>()).toMatchObject({
      identifier: MERCHANT_ID,
      displayName: 'Northwind Supplies',
    });
  });

  it('reports the environment the key was issued for', async () => {
    const testKey = await issueKey(MERCHANT_ID, 'test');
    const liveKey = await issueKey(MERCHANT_ID, 'live');

    const testResponse = await authenticatedRequest(testKey.presentedKey);
    const liveResponse = await authenticatedRequest(liveKey.presentedKey);

    expect(testResponse.json<{ environment: string }>()).toMatchObject({ environment: 'test' });
    expect(liveResponse.json<{ environment: string }>()).toMatchObject({ environment: 'live' });
  });

  it('echoes the environment in a header, so a client cannot mistake which world it is in', async () => {
    const key = await issueKey(MERCHANT_ID, 'live');
    const response = await authenticatedRequest(key.presentedKey);
    expect(response.headers['cryptopay-environment']).toBe('live');
  });

  it('records that the key was used', async () => {
    const key = await issueKey(MERCHANT_ID, 'test');
    await authenticatedRequest(key.presentedKey);

    // Usage recording is deliberately not awaited by the request, so it is observed by polling.
    await expect
      .poll(async () => {
        const result = await pool.query<{ last_used_at: Date | null }>(
          'SELECT last_used_at FROM api_keys WHERE id = $1',
          [key.keyIdentifier],
        );
        return result.rows[0]?.last_used_at !== null;
      })
      .toBe(true);
  });

  it('answers a second merchant with its own record', async () => {
    const key = await issueKey(OTHER_MERCHANT_ID, 'test');
    const response = await authenticatedRequest(key.presentedKey);
    expect(response.json<{ identifier: string }>()).toMatchObject({
      identifier: OTHER_MERCHANT_ID,
    });
  });
});

describe('rejecting an invalid key', () => {
  it('rejects a request with no authorization header', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/merchants/me' });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    { description: 'a bare token with no scheme', header: 'cp_test_abc' },
    { description: 'the wrong scheme', header: 'Basic cp_test_abc' },
    { description: 'an empty bearer value', header: 'Bearer ' },
    { description: 'a malformed key', header: 'Bearer not-a-key' },
    {
      description: 'a well-formed key that was never issued',
      header: `Bearer cp_test_01K4QW6ZR2M8X4T7YQ0C3D5B9N_${'a'.repeat(43)}`,
    },
  ])('rejects $description', async ({ header }) => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/merchants/me',
      headers: { authorization: header },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const key = await issueKey(MERCHANT_ID, 'test', { revoked: true });
    const response = await authenticatedRequest(key.presentedKey);
    expect(response.statusCode).toBe(401);
  });

  it('rejects a key whose secret has been altered', async () => {
    const key = await issueKey(MERCHANT_ID, 'test');
    const tampered = `${key.presentedKey.slice(0, -1)}${key.presentedKey.endsWith('A') ? 'B' : 'A'}`;
    const response = await authenticatedRequest(tampered);
    expect(response.statusCode).toBe(401);
  });

  // Editing the prefix of a test key must not present it as a live key. The environment named in
  // the key is checked against the environment the key was issued for.
  it('rejects a test key with its prefix edited to live', async () => {
    const key = await issueKey(MERCHANT_ID, 'test');
    const promoted = key.presentedKey.replace('cp_test_', 'cp_live_');
    const response = await authenticatedRequest(promoted);
    expect(response.statusCode).toBe(401);
  });

  it('rejects a live key demoted to test', async () => {
    const key = await issueKey(MERCHANT_ID, 'live');
    const demoted = key.presentedKey.replace('cp_live_', 'cp_test_');
    const response = await authenticatedRequest(demoted);
    expect(response.statusCode).toBe(401);
  });

  // Distinguishing "no such key" from "wrong secret" would let a caller confirm which identifiers
  // exist, so every rejection must be byte-identical apart from the request identifier.
  it('answers every rejection identically', async () => {
    const unknown = await server.inject({
      method: 'GET',
      url: '/v1/merchants/me',
      headers: { authorization: `Bearer cp_test_01K4QW6ZR2M8X4T7YQ0C3D5B9N_${'a'.repeat(43)}` },
    });
    const revoked = await issueKey(MERCHANT_ID, 'test', { revoked: true });
    const revokedResponse = await authenticatedRequest(revoked.presentedKey);
    const malformed = await server.inject({
      method: 'GET',
      url: '/v1/merchants/me',
      headers: { authorization: 'Bearer not-a-key' },
    });

    expect(withoutRequestId(revokedResponse.body)).toBe(withoutRequestId(unknown.body));
    expect(withoutRequestId(malformed.body)).toBe(withoutRequestId(unknown.body));
  });

  it('returns problem details rather than a bare status', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/merchants/me' });
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json<{ code: string }>()).toMatchObject({ code: 'unauthorized' });
  });

  it('never echoes the presented key back', async () => {
    const key = await issueKey(MERCHANT_ID, 'test', { revoked: true });
    const response = await authenticatedRequest(key.presentedKey);
    expect(response.body).not.toContain(key.presentedKey);
  });
});

describe('unauthenticated routes', () => {
  it('leaves liveness open', async () => {
    const response = await server.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});
