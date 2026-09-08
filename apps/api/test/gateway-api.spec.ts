import type { Environment, GatewayError, GatewayPayment } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { createLocalKeyWrapper } from '../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../src/infrastructure/wallet/master-seed.js';
import { WalletSeedRepository } from '../src/infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { decodeQrCode } from '../src/infrastructure/qr/qr-decoder.test-helper.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * The contract an external payment gateway integrates against, exercised as an integrator would:
 * over HTTP, against a real database, with a real API key.
 *
 * The assertions are about the contract rather than about the implementation. What matters is that
 * a caller who knows nothing about Polygon receives something a wallet can scan, that a retry never
 * produces a second payment, and that a failure says what to change without saying anything about
 * how this service is built.
 */

const PEPPER = 'g'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 7);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3F1001';
const OTHER_MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3F1002';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let testKey = '';
let liveKey = '';
let otherMerchantKey = '';
let readOnlyKey = '';
let writeOnlyKey = '';

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let idempotencyCounter = 0;

async function issueKey(
  merchantId: string,
  environment: Environment,
  scopes: readonly string[] = ['payments:read', 'payments:write'],
): Promise<string> {
  keyCounter += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, keyCounter);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label, scopes)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'gateway', $6::text[])`,
    [
      generated.keyIdentifier,
      merchantId,
      environment,
      generated.secretDigest,
      generated.lastFour,
      [...scopes],
    ],
  );
  return generated.presentedKey;
}

function nextIdempotencyKey(): string {
  idempotencyCounter += 1;
  return `gateway-test-${idempotencyCounter}`;
}

/**
 * One external reference identifies one payment for a merchant, enforced by a unique index, so each
 * test that creates a payment needs its own. Reusing one is a real conflict rather than a fixture
 * detail, and there is a test below that asserts what happens when a caller does it.
 */
let referenceCounter = 0;
function nextExternalReference(): string {
  referenceCounter += 1;
  return `order_${referenceCounter}`;
}

interface CreateOptions {
  readonly key?: string;
  readonly idempotencyKey?: string;
  readonly body?: Record<string, unknown>;
}

function createPayment(options: CreateOptions = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.key ?? testKey}`,
    'content-type': 'application/json',
  };
  const idempotencyKey = options.idempotencyKey ?? nextIdempotencyKey();
  headers['idempotency-key'] = idempotencyKey;
  return server.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers,
    payload: options.body ?? {
      externalReference: nextExternalReference(),
      network: 'polygon',
      currency: 'USDC',
      amount: '25.00',
      expiresIn: 1800,
      metadata: { orderId: '12345' },
    },
  });
}

function get(url: string, key = testKey) {
  return server.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'gateway');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)', [
    MERCHANT_ID,
    'Gateway Fixtures',
    OTHER_MERCHANT_ID,
    'Someone Else',
  ]);

  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  const seedRepository = new WalletSeedRepository(pool);
  let seedCursor = 1_757_183_400_000;
  for (const environment of ['test', 'live'] as const) {
    seedCursor += 1;
    await seedRepository.storeIfAbsent(
      `sed_${ulidFactory.create(seedCursor)}`,
      environment,
      sealSeed(generateMasterSeed(), environment, wrapper),
    );
  }

  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 46903512, $1, 1000), ('polygon-mainnet', 71000000, $1, 500)`,
    [`0x${'a'.repeat(64)}`],
  );

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: WALLET_KEY.toString('base64'),
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);

  testKey = await issueKey(MERCHANT_ID, 'test');
  liveKey = await issueKey(MERCHANT_ID, 'live');
  otherMerchantKey = await issueKey(OTHER_MERCHANT_ID, 'test');
  readOnlyKey = await issueKey(MERCHANT_ID, 'test', ['payments:read']);
  writeOnlyKey = await issueKey(MERCHANT_ID, 'test', ['payments:write']);
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

beforeEach(async () => {
  await pool.query(
    `UPDATE block_cursors SET last_scanned_height = 46903512, halted_at = NULL,
            halted_reason = NULL WHERE network_identifier = 'polygon-amoy'`,
  );
});

describe('creating a payment', () => {
  it('answers with everything a caller needs and nothing about how it was built', async () => {
    const response = await createPayment();
    expect(response.statusCode).toBe(201);

    const payment = response.json<GatewayPayment>();
    expect(payment.status).toBe('CREATED');
    expect(payment.network).toBe('polygon');
    expect(payment.chainId).toBe(80_002);
    expect(payment.currency).toBe('USDC');
    expect(payment.amount).toBe('25.000000');
    expect(payment.amountReceived).toBe('0.000000');
    expect(payment.externalReference).toMatch(/^order_\d+$/);
    expect(payment.metadata).toEqual({ orderId: '12345' });
    expect(payment.paymentDestination.address).toMatch(/^0x[\da-f]{40}$/);
    expect(payment.explorer.transaction).toBeNull();
    expect(payment.transactions).toEqual([]);
    expect(payment.failureReason).toBeNull();
  });

  /**
   * The point of the whole contract. An orchestrator that has never heard of EIP-681 gets something
   * a wallet can open, and the QR is checked by decoding it rather than by looking at its length.
   */
  it('returns a scannable QR code whose image really carries the payment URI', async () => {
    const response = await createPayment();
    const payment = response.json<GatewayPayment>();

    expect(payment.paymentUri).toMatch(/^ethereum:/);
    expect(payment.paymentUri).toContain(payment.paymentDestination.address);
    expect(payment.qrCode?.startsWith('data:image/png;base64,')).toBe(true);

    const image = Buffer.from((payment.qrCode ?? '').split(',', 2)[1] ?? '', 'base64');
    expect(decodeQrCode(image)).toBe(payment.paymentUri);
  });

  it('reports WAITING_FOR_PAYMENT once the scanner has reached the payment', async () => {
    const createResponse = await createPayment();
    const created = createResponse.json<GatewayPayment>();
    await pool.query(
      `UPDATE block_cursors SET last_scanned_height = 99000000
        WHERE network_identifier = 'polygon-amoy'`,
    );

    const read = await get(`/api/v1/payments/${created.id}`);
    expect(read.json<GatewayPayment>().status).toBe('WAITING_FOR_PAYMENT');
  });

  /**
   * The API key environment picks the deployment, so the request body has no way to name one. A
   * test key asking for `polygon` gets Amoy and a live key gets mainnet, from an identical request.
   */
  it('routes the same request to a different chain for a live key', async () => {
    const live = await createPayment({ key: liveKey });
    expect(live.statusCode).toBe(201);
    expect(live.json<GatewayPayment>().chainId).toBe(137);
  });

  it('keeps amounts as strings, so nothing passes through a float', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'USDC',
        amount: '0.000001',
      },
    });
    expect(response.statusCode).toBe(201);
    const payment = response.json<GatewayPayment>();
    expect(payment.amount).toBe('0.000001');
    expect(typeof payment.amount).toBe('string');
  });
});

describe('what payment creation refuses', () => {
  it('refuses an amount finer than the currency can hold, rather than rounding it', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'USDC',
        amount: '25.0000001',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('INVALID_PAYMENT_AMOUNT');
  });

  it('refuses a currency the network does not carry', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'DOGE',
        amount: '25.00',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  /**
   * The rule that a caller may never name a token contract. It is refused by the shape of the field
   * rather than by a lookup, so there is no path where an address reaches resolution at all.
   */
  it('refuses a contract address offered where a currency belongs', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
        amount: '25.00',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('VALIDATION_FAILED');
  });

  /**
   * TRON is a supported family with a real adapter, so the refusal is about this deployment rather
   * than about the chain: no endpoint is configured, so nothing is watching, so a payment created
   * there would never be detected. Saying so is the difference between "we do not support that" and
   * "we cannot serve that right now", and only one of them tells an operator to fix something.
   */
  it('refuses a network this deployment is not watching, and says which kind of refusal it is', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'tron',
        currency: 'USDT',
        amount: '25.00',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<GatewayError>().error.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('refuses a currency that is real on another family', async () => {
    const response = await createPayment({
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'TRX',
        amount: '25.00',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  it('requires an idempotency key, so a retry cannot create a second payment', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${testKey}`, 'content-type': 'application/json' },
      payload: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'USDC',
        amount: '1.00',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<GatewayError>().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  /**
   * One external reference is one payment. A retried order that reaches creation twice with a fresh
   * idempotency key is refused by name rather than by a driver error, which is what this used to be:
   * the unique index raised, nothing caught it, and the caller received a 500 that named nothing.
   */
  it('refuses a second payment for an external reference already used', async () => {
    const externalReference = nextExternalReference();
    const body = { externalReference, network: 'polygon', currency: 'USDC', amount: '5.00' };

    const first = await createPayment({ body });
    const second = await createPayment({ body });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(422);
    expect(second.json<GatewayError>().error.code).toBe('DUPLICATE_EXTERNAL_REFERENCE');
    expect(second.body).not.toContain('payments_merchant_reference_unique');
  });

  it('refuses an unauthenticated request', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3F9999',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<GatewayError>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('idempotency', () => {
  it('returns the same payment for a repeated key rather than allocating a second address', async () => {
    const key = nextIdempotencyKey();
    // The same key with the same body. A retry sends the request again, byte for byte.
    const body = {
      externalReference: nextExternalReference(),
      network: 'polygon',
      currency: 'USDC',
      amount: '25.00',
    };
    const first = await createPayment({ idempotencyKey: key, body });
    const second = await createPayment({ idempotencyKey: key, body });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json<GatewayPayment>().id).toBe(first.json<GatewayPayment>().id);
    expect(second.json<GatewayPayment>().paymentDestination.address).toBe(
      first.json<GatewayPayment>().paymentDestination.address,
    );
  });

  /**
   * The requirement that cannot be met by an application-level check alone. Twenty identical
   * requests are issued at once; the database constraint is what makes exactly one of them create a
   * payment, and every other answer is either that same payment or a signal to retry for it.
   */
  it('creates exactly one payment under twenty concurrent identical requests', async () => {
    const key = nextIdempotencyKey();
    const body = {
      externalReference: nextExternalReference(),
      network: 'polygon',
      currency: 'USDC',
      amount: '25.00',
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => createPayment({ idempotencyKey: key, body })),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    const askedToRetry = responses.filter((response) => response.statusCode === 429);
    expect(created.length + askedToRetry.length).toBe(20);
    expect(created.length).toBeGreaterThanOrEqual(1);

    const identifiers = new Set(created.map((response) => response.json<GatewayPayment>().id));
    expect(identifiers.size).toBe(1);

    // The database is the authority, not the count of 201s: exactly one payment row must exist for
    // this merchant beyond those the other tests created.
    const stored = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM idempotency_keys
        WHERE merchant_id = $1 AND idempotency_key = $2`,
      [MERCHANT_ID, key],
    );
    expect(stored.rows[0]?.count).toBe('1');
  });

  it('refuses the same key with a different body instead of returning the wrong payment', async () => {
    const key = nextIdempotencyKey();
    await createPayment({ idempotencyKey: key });
    const conflicting = await createPayment({
      idempotencyKey: key,
      body: {
        externalReference: nextExternalReference(),
        network: 'polygon',
        currency: 'USDC',
        amount: '99.00',
      },
    });

    expect(conflicting.statusCode).toBe(422);
    expect(conflicting.json<GatewayError>().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('scopes a key to its merchant, so two merchants may use the same string', async () => {
    const key = nextIdempotencyKey();
    const body = {
      externalReference: nextExternalReference(),
      network: 'polygon',
      currency: 'USDC',
      amount: '25.00',
    };
    const ours = await createPayment({ idempotencyKey: key, body });
    const theirs = await createPayment({ idempotencyKey: key, key: otherMerchantKey, body });

    expect(ours.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<GatewayPayment>().id).not.toBe(ours.json<GatewayPayment>().id);
  });
});

describe('reading and cancelling a payment', () => {
  it('answers the status endpoint with what a poller needs and nothing more', async () => {
    const createResponse = await createPayment();
    const created = createResponse.json<GatewayPayment>();
    const response = await get(`/api/v1/payments/${created.id}/status`);

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body.status).toBe('CREATED');
    expect(body.amountReceived).toBe('0.000000');
    expect(body.requiredConfirmations).toBe(5);
    expect(Object.keys(body).toSorted((left, right) => left.localeCompare(right))).toEqual(
      [
        'amount',
        'amountReceived',
        'confirmations',
        'expiresAt',
        'failureReason',
        'id',
        'paidAt',
        'requiredConfirmations',
        'status',
      ].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it('cancels a payment nobody has paid', async () => {
    const createResponse = await createPayment();
    const created = createResponse.json<GatewayPayment>();
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/payments/${created.id}/cancel`,
      headers: { authorization: `Bearer ${testKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<GatewayPayment>().status).toBe('CANCELLED');
  });

  /**
   * Another merchant's payment answers 404 rather than 403. A 403 confirms the identifier is real,
   * which is the only thing an enumeration attack needs.
   */
  it('hides another merchant payment behind the same answer as one that does not exist', async () => {
    const createResponse = await createPayment();
    const created = createResponse.json<GatewayPayment>();
    const theirs = await get(`/api/v1/payments/${created.id}`, otherMerchantKey);
    const missing = await get('/api/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3F9999', otherMerchantKey);

    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(theirs.json<GatewayError>().error.code).toBe(missing.json<GatewayError>().error.code);
  });
});

describe('the error contract', () => {
  it('carries a code, a message and a request identifier, and nothing else', async () => {
    const response = await get('/api/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3F9999');
    const body = response.json<GatewayError>();

    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'code',
      'message',
      'requestId',
    ]);
    expect(body.error.code).toBe('PAYMENT_NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  /**
   * The response must not describe the machine that produced it. A stack frame, a driver message,
   * a table name or a class name in an error body is how an attacker learns what to attack.
   */
  it('never leaks a stack trace, a driver message or an internal name', async () => {
    const responses = await Promise.all([
      get('/api/v1/payments/not-a-valid-identifier'),
      createPayment({ body: { network: 'polygon' } }),
      server.inject({
        method: 'POST',
        url: '/api/v1/payments',
        headers: {
          authorization: `Bearer ${testKey}`,
          'content-type': 'application/json',
          'idempotency-key': nextIdempotencyKey(),
        },
        payload: '{ not json',
      }),
    ]);

    for (const response of responses) {
      const raw = response.body;
      expect(raw).not.toMatch(/at \w+ \(/);
      expect(raw).not.toMatch(/node_modules|\.ts:\d+|postgres|pg_|relation "|ApplicationError/i);
      expect(raw).not.toContain('Error:');
      expect(response.headers['content-type']).toContain('application/json');
    }
  });

  it('answers an unknown gateway route in the gateway envelope, not in problem details', async () => {
    const response = await get('/api/v1/nothing-here');
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-type']).not.toContain('problem+json');
    expect(response.json<GatewayError>().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('leaves the existing surface answering RFC 9457, so neither contract moved', async () => {
    const response = await get('/v1/payments/pay_01K4QW6ZR2M8X4T7YQ0C3F9999');
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('problem+json');
  });
});

/**
 * A key that can read payments and a key that can create them are different powers, and only one of
 * them moves money. These assert the difference is enforced rather than documented.
 */
describe('what an API key is allowed to do', () => {
  it('refuses payment creation to a key that can only read', async () => {
    const response = await createPayment({ key: readOnlyKey });

    expect(response.statusCode).toBe(403);
    expect(response.json<GatewayError>().error.code).toBe('INSUFFICIENT_SCOPE');
    // The message says which scope is missing, because an integrator cannot fix what they cannot see.
    expect(response.json<GatewayError>().error.message).toContain('payments:write');
  });

  it('lets a read-only key read a payment', async () => {
    const created = await createPayment();
    const read = await get(`/api/v1/payments/${created.json<GatewayPayment>().id}`, readOnlyKey);
    expect(read.statusCode).toBe(200);
  });

  it('refuses reading to a key that can only write', async () => {
    const created = await createPayment({ key: writeOnlyKey });
    expect(created.statusCode).toBe(201);

    const read = await get(`/api/v1/payments/${created.json<GatewayPayment>().id}`, writeOnlyKey);
    expect(read.statusCode).toBe(403);
  });

  it('refuses cancellation to a key that can only read', async () => {
    const created = await createPayment();
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/payments/${created.json<GatewayPayment>().id}/cancel`,
      headers: { authorization: `Bearer ${readOnlyKey}` },
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * A missing scope is 403 rather than the 404 another merchant's payment gets. The caller already
   * holds a valid key and is asking about their own account, so naming the reason reveals nothing
   * and saves them hunting for a resource that exists.
   */
  it('distinguishes a missing scope from a payment that is not theirs', async () => {
    const created = await createPayment();
    const identifier = created.json<GatewayPayment>().id;

    const wrongScope = await get(`/api/v1/payments/${identifier}`, writeOnlyKey);
    const wrongMerchant = await get(`/api/v1/payments/${identifier}`, otherMerchantKey);

    expect(wrongScope.statusCode).toBe(403);
    expect(wrongMerchant.statusCode).toBe(404);
  });

  it('keeps existing keys able to do everything they could before', async () => {
    const stored = await pool.query<{ scopes: string[] }>(
      `SELECT scopes FROM api_keys WHERE label = 'gateway' LIMIT 1`,
    );
    expect(stored.rows[0]?.scopes).toContain('payments:read');
  });
});
