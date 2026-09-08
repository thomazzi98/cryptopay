import { documentedOperations, type Environment, type NetworkList } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { generateApiKey } from '../src/infrastructure/crypto/api-key.js';
import { WalletSeedRepository } from '../src/infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { createLocalKeyWrapper } from '../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../src/infrastructure/wallet/master-seed.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Payment creation end to end, against a real database and a real sealed wallet seed.
 *
 * The properties that matter here are not the happy path but the ones that cost money when wrong:
 * a retried request must not create a second payment, two payments must never share an address, and
 * a test key must be unable to reach mainnet.
 */

const alphabetically = (left: string, right: string): number => left.localeCompare(right);

const PEPPER = 'p'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 5);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const OTHER_MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9P';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let testKey: string;
let liveKey: string;
let otherMerchantKey: string;

const ulidFactory = new UlidFactory();
let timeCursor = 1_757_183_400_000;

async function issueKey(merchantId: string, environment: Environment): Promise<string> {
  timeCursor += 1;
  const generated = generateApiKey(environment, PEPPER, ulidFactory, timeCursor);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'integration')`,
    [generated.keyIdentifier, merchantId, environment, generated.secretDigest, generated.lastFour],
  );
  return generated.presentedKey;
}

interface CreateOptions {
  readonly key?: string;
  readonly idempotencyKey?: string;
  readonly body?: Record<string, unknown>;
}

let idempotencyCounter = 0;

function createPayment(options: CreateOptions = {}) {
  idempotencyCounter += 1;
  return server.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: {
      authorization: `Bearer ${options.key ?? testKey}`,
      'idempotency-key': options.idempotencyKey ?? `key-${idempotencyCounter}`,
      'content-type': 'application/json',
    },
    payload: options.body ?? { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00' },
  });
}

beforeAll(async () => {
  const port = inject('postgresPort');
  const isolated = await createIsolatedDatabase(port, 'payments');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)', [
    MERCHANT_ID,
    'Northwind Supplies',
    OTHER_MERCHANT_ID,
    'Someone Else',
  ]);

  // Both environments get a sealed seed, and both networks get a cursor: a payment is refused for a
  // network no scanner is watching, which is asserted separately.
  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  const seedRepository = new WalletSeedRepository(pool);
  for (const environment of ['test', 'live'] as const) {
    await seedRepository.storeIfAbsent(
      `sed_${ulidFactory.create(timeCursor)}`,
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
    DATABASE_URL: connectionUrlFor(isolated.databaseName, port),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: WALLET_KEY.toString('base64'),
    PUBLIC_CHECKOUT_BASE_URL: 'https://pay.example.com/pay',
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);

  testKey = await issueKey(MERCHANT_ID, 'test');
  liveKey = await issueKey(MERCHANT_ID, 'live');
  otherMerchantKey = await issueKey(OTHER_MERCHANT_ID, 'test');
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

describe('creating a payment', () => {
  it('returns the created payment with an address of its own', async () => {
    const response = await createPayment();
    expect(response.statusCode).toBe(201);

    const payment = response.json<{
      identifier: string;
      status: string;
      receivingAccount: string;
      requestedAmount: { baseUnits: string; display: string };
      requiredConfirmations: number;
      checkoutUrl: string;
    }>();

    expect(payment.identifier).toMatch(/^pay_[\dABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    expect(payment.status).toBe('pending');
    expect(payment.receivingAccount).toMatch(/^0x[\da-f]{40}$/);
    expect(payment.requestedAmount).toStrictEqual({ baseUnits: '25000000', display: '25.000000' });
    expect(payment.requiredConfirmations).toBe(5);
    expect(payment.checkoutUrl.startsWith('https://pay.example.com/pay/')).toBe(true);
  });

  it('never returns anything derived from key material', async () => {
    const response = await createPayment();
    for (const forbidden of [
      'allocationReference',
      'derivationIndex',
      'derivationPath',
      'privateKey',
      'masterSeed',
      "m/44'",
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it('gives every payment a different address', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => createPayment()));
    const accounts = new Set(
      responses.map((response) => response.json<{ receivingAccount: string }>().receivingAccount),
    );
    expect(accounts.size).toBe(12);
  });

  it('records the address it issued', async () => {
    const response = await createPayment();
    const payment = response.json<{ identifier: string; receivingAccount: string }>();

    const stored = await pool.query<{ account: string; allocation_reference: string }>(
      'SELECT account, allocation_reference FROM payment_addresses WHERE payment_id = $1',
      [payment.identifier],
    );
    expect(stored.rows[0]?.account).toBe(payment.receivingAccount);
    expect(stored.rows[0]?.allocation_reference).toMatch(/^m\/44'\/60'\/0'\/0\/\d+$/);
  });

  it('applies the merchant tolerance to the acceptance band', async () => {
    await pool.query(
      'UPDATE merchants SET underpayment_tolerance_basis_points = 100 WHERE id = $1',
      [MERCHANT_ID],
    );
    const response = await createPayment();
    const payment = response.json<{ acceptanceBand: { minimumBaseUnits: string } }>();
    expect(payment.acceptanceBand.minimumBaseUnits).toBe('24750000');

    await pool.query('UPDATE merchants SET underpayment_tolerance_basis_points = 0 WHERE id = $1', [
      MERCHANT_ID,
    ]);
  });
});

describe('rejecting a payment that cannot settle', () => {
  it.each([
    { description: 'an unknown network', body: { network: 'ethereum-mainnet' } },
    { description: 'an asset the network does not settle', body: { assetSymbol: 'DAI' } },
    { description: 'an amount that is not a number', body: { amount: 'twenty' } },
    { description: 'a negative amount', body: { amount: '-25.00' } },
    { description: 'more precision than the asset holds', body: { amount: '25.0000001' } },
    { description: 'a lifetime beyond a day', body: { expiresInSeconds: 86_401 } },
  ])('rejects $description', async ({ body }) => {
    const response = await createPayment({
      body: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00', ...body },
    });
    expect(response.statusCode).toBe(422);
  });

  /**
   * The destination policy runs at creation, not only before a delivery. A merchant whose callback
   * can never be reached learns it while they are looking at the response, and the reason they are
   * given is the one the delivery worker would have produced, because it is the same function.
   */
  it.each([
    { description: 'plain http', callbackUrl: 'http://merchant.example.com/hook' },
    { description: 'a port other than 443', callbackUrl: 'https://merchant.example.com:8443/h' },
    { description: 'a single-label host', callbackUrl: 'https://intranet/hook' },
    { description: 'a loopback name', callbackUrl: 'https://api.localhost/hook' },
  ])('refuses a callback on $description at creation time', async ({ callbackUrl }) => {
    const response = await createPayment({
      body: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00', callbackUrl },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('callback URL cannot be used');
  });

  it('accepts a callback a merchant could actually run', async () => {
    const response = await createPayment({
      body: {
        network: 'polygon-amoy',
        assetSymbol: 'USDC',
        amount: '25.00',
        callbackUrl: 'https://hooks.merchant.example/cryptopay',
      },
    });
    expect(response.statusCode).toBe(201);
  });

  /**
   * The environment carried by the key decides which networks are reachable. The database CHECK
   * enforces the same rule, so this is the friendly error rather than the only defence.
   */
  it('refuses a test key creating a payment on mainnet', async () => {
    const response = await createPayment({
      key: testKey,
      body: { network: 'polygon-mainnet', assetSymbol: 'USDC', amount: '25.00' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('cannot create payments on Polygon');
  });

  it('refuses a live key creating a payment on the testnet', async () => {
    const response = await createPayment({
      key: liveKey,
      body: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('requires an idempotency key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${testKey}`, 'content-type': 'application/json' },
      payload: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('Idempotency-Key');
  });

  it('rejects an unauthenticated request', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'idempotency-key': 'no-auth' },
      payload: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '25.00' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('idempotent creation', () => {
  it('replays the first response rather than creating a second payment', async () => {
    const first = await createPayment({ idempotencyKey: 'repeat-me' });
    const second = await createPayment({ idempotencyKey: 'repeat-me' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json<{ identifier: string }>().identifier).toBe(
      first.json<{ identifier: string }>().identifier,
    );
  });

  /**
   * The property the whole two-phase design exists for. Without a reservation taken before the work
   * runs, each of these would allocate an address before colliding.
   */
  it('creates exactly one payment from twenty simultaneous identical requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => createPayment({ idempotencyKey: 'stampede' })),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    const identifiers = new Set(
      created.map((response) => response.json<{ identifier: string }>().identifier),
    );
    expect(identifiers.size).toBe(1);

    const stored = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM payments WHERE merchant_id = $1',
      [MERCHANT_ID],
    );
    expect(Number(stored.rows[0]?.count)).toBeGreaterThan(0);
  });

  it('rejects the same key with a different body', async () => {
    await createPayment({ idempotencyKey: 'changed-body' });
    const second = await createPayment({
      idempotencyKey: 'changed-body',
      body: { network: 'polygon-amoy', assetSymbol: 'USDC', amount: '99.00' },
    });
    expect(second.statusCode).toBe(422);
  });

  it('does not consume the key when the request was rejected', async () => {
    const rejected = await createPayment({
      idempotencyKey: 'recoverable',
      body: { network: 'polygon-amoy', assetSymbol: 'DAI', amount: '25.00' },
    });
    expect(rejected.statusCode).toBe(422);

    const retried = await createPayment({
      idempotencyKey: 'recoverable',
      body: { network: 'polygon-amoy', assetSymbol: 'DAI', amount: '25.00' },
    });
    expect(retried.statusCode).toBe(422);
  });
});

describe('reading payments', () => {
  it('returns a payment by identifier', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    const response = await server.inject({
      method: 'GET',
      url: `/v1/payments/${identifier}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ identifier: string }>().identifier).toBe(identifier);
  });

  // 404 rather than 403: a 403 would confirm that the identifier exists.
  it('hides another merchant payment behind a 404', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    const response = await server.inject({
      method: 'GET',
      url: `/v1/payments/${identifier}`,
      headers: { authorization: `Bearer ${otherMerchantKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lists payments newest first', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/payments?limit=5',
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(response.statusCode).toBe(200);

    const page = response.json<{ data: { identifier: string }[]; hasMore: boolean }>();
    expect(page.data.length).toBeLessThanOrEqual(5);
    const identifiers = page.data.map((payment) => payment.identifier);
    expect(identifiers).toStrictEqual([...identifiers].toSorted(alphabetically).toReversed());
  });

  it('pages with a stable cursor', async () => {
    const first = await server.inject({
      method: 'GET',
      url: '/v1/payments?limit=3',
      headers: { authorization: `Bearer ${testKey}` },
    });
    const firstPage = first.json<{ data: { identifier: string }[]; nextCursor: string | null }>();

    const second = await server.inject({
      method: 'GET',
      url: `/v1/payments?limit=3&startingAfter=${firstPage.nextCursor ?? ''}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    const secondPage = second.json<{ data: { identifier: string }[] }>();

    const firstIdentifiers = new Set(firstPage.data.map((payment) => payment.identifier));
    for (const payment of secondPage.data) {
      expect(firstIdentifiers.has(payment.identifier)).toBe(false);
    }
  });

  it('shows a merchant only its own payments', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/payments?limit=100',
      headers: { authorization: `Bearer ${otherMerchantKey}` },
    });
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('separates test payments from live ones', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/payments?limit=100',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });
});

describe('cancelling a payment', () => {
  it('cancels a pending payment', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    const response = await server.inject({
      method: 'POST',
      url: `/v1/payments/${identifier}/cancel`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('canceled');
  });

  it('records the cancellation in the audit trail', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    await server.inject({
      method: 'POST',
      url: `/v1/payments/${identifier}/cancel`,
      headers: { authorization: `Bearer ${testKey}` },
    });

    const audit = await pool.query<{ from_status: string; to_status: string }>(
      'SELECT from_status, to_status FROM payment_status_transitions WHERE payment_id = $1',
      [identifier],
    );
    expect(audit.rows[0]).toMatchObject({ from_status: 'pending', to_status: 'canceled' });
  });

  it('treats a repeated cancellation as already done', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;
    const cancel = () =>
      server.inject({
        method: 'POST',
        url: `/v1/payments/${identifier}/cancel`,
        headers: { authorization: `Bearer ${testKey}` },
      });

    await cancel();
    const second = await cancel();
    expect(second.statusCode).toBe(200);
    expect(second.json<{ status: string }>().status).toBe('canceled');
  });

  it('answers 404 for another merchant payment', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    const response = await server.inject({
      method: 'POST',
      url: `/v1/payments/${identifier}/cancel`,
      headers: { authorization: `Bearer ${otherMerchantKey}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the callback a cancellation produces', () => {
  it('enqueues the promised payment.canceled delivery', async () => {
    const created = await createPayment({
      body: {
        network: 'polygon-amoy',
        assetSymbol: 'USDC',
        amount: '25.00',
        callbackUrl: 'https://hooks.merchant.example/cryptopay',
      },
    });
    const identifier = created.json<{ identifier: string }>().identifier;

    await server.inject({
      method: 'POST',
      url: `/v1/payments/${identifier}/cancel`,
      headers: { authorization: `Bearer ${testKey}` },
    });

    const delivery = await pool.query<{
      event_type: string;
      destination_url: string;
      payload: string;
    }>(
      'SELECT event_type, destination_url, payload FROM webhook_deliveries WHERE payment_id = $1',
      [identifier],
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0]).toMatchObject({
      event_type: 'payment.canceled',
      destination_url: 'https://hooks.merchant.example/cryptopay',
    });
    expect(JSON.parse(delivery.rows[0]!.payload)).toMatchObject({
      type: 'payment.canceled',
      data: { identifier, status: 'canceled' },
    });
  });

  it('enqueues nothing for a merchant who is polling instead', async () => {
    const created = await createPayment();
    const identifier = created.json<{ identifier: string }>().identifier;

    await server.inject({
      method: 'POST',
      url: `/v1/payments/${identifier}/cancel`,
      headers: { authorization: `Bearer ${testKey}` },
    });

    const delivery = await pool.query('SELECT 1 FROM webhook_deliveries WHERE payment_id = $1', [
      identifier,
    ]);
    expect(delivery.rowCount).toBe(0);
  });
});

/**
 * What another system integrates against: the contract document and the discovery endpoint that
 * keeps chain identifiers, token addresses and confirmation counts out of their source code.
 */
describe('the integration surface', () => {
  it('serves the contract without a key, because a document nobody can read is not a contract', async () => {
    const response = await server.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json<{ openapi: string }>().openapi).toBe('3.1.0');
  });

  it('documents only endpoints this server actually serves', () => {
    for (const operation of documentedOperations()) {
      const url = operation.path.replaceAll(/\{(?<parameter>[^}]+)\}/gu, ':$<parameter>');
      expect(server.hasRoute({ method: operation.method.toUpperCase() as 'GET', url })).toBe(true);
    }
  });

  it('lists the networks a test key may use, and only those', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/networks',
      headers: { authorization: `Bearer ${testKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<NetworkList>();
    expect(body.data.map((network) => network.network)).toStrictEqual(['polygon-amoy']);
    expect(body.data[0]).toMatchObject({
      chainIdentifier: 80_002,
      requiredConfirmations: 5,
      requiresFinalityTag: true,
      // Never configured in this test, and never guessed from a scanning endpoint that may carry a
      // provider key.
      walletRpcUrl: null,
    });
    expect(body.data[0]?.assets).toStrictEqual([
      { reference: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', symbol: 'USDC', decimals: 6 },
    ]);
  });

  it('never offers a live network to a test key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/networks',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    const body = response.json<NetworkList>();
    expect(body.data.map((network) => network.network)).toStrictEqual(['polygon-mainnet']);
  });

  it('never lists the bridged token, which reports the identical symbol', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/networks',
      headers: { authorization: `Bearer ${liveKey}` },
    });
    const references = response
      .json<NetworkList>()
      .data.flatMap((network) => network.assets.map((asset) => asset.reference));
    expect(references).toContain('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    expect(references).not.toContain('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
  });

  it('requires a key to enumerate networks', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/networks' });
    expect(response.statusCode).toBe(401);
  });
});
