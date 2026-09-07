import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildApplicationServer } from '../src/composition-root.js';
import { loadConfiguration } from '../src/configuration.js';
import type { ApplicationServer } from '../src/http/server-types.js';
import { connectionUrlFor, createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * The public checkout, which a customer's browser reaches with no API key.
 *
 * Two properties are asserted here and they are the ones that matter. The response must not carry
 * anything belonging to the merchant's side of the arrangement, because the token is held by a
 * stranger. And the transaction hint must change nothing: it schedules a look, and every figure is
 * still re-derived from the chain, so a fabricated hash is worth exactly nothing.
 */

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3F1001';
const PAYMENT_ID = 'pay_01K4QW6ZR2M8X4T7YQ0C3F1001';
const CHECKOUT_TOKEN = 'tok_9fJ2kLpQx7mNvR4sT1uW8yZ0aBcDeFgH';
const ACCOUNT = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const SOURCE_ACCOUNT = '0x8c2b5f7d0e1a3b4c6d8e9f01a2b3c4d5e6f70b1c';
const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;

function getCheckout(token = CHECKOUT_TOKEN) {
  return server.inject({ method: 'GET', url: `/v1/checkout/${token}` });
}

async function sendHint(body: Record<string, unknown>, token = CHECKOUT_TOKEN) {
  return server.inject({
    method: 'POST',
    url: `/v1/checkout/${token}/transaction-hint`,
    payload: body,
  });
}

async function hintStatus(body: Record<string, unknown>, token = CHECKOUT_TOKEN): Promise<number> {
  const response = await sendHint(body, token);
  return response.statusCode;
}

async function readPayment() {
  const result = await pool.query<{
    status: string;
    credited_amount: string;
    status_version: number;
  }>('SELECT status, credited_amount, status_version FROM payments WHERE id = $1', [PAYMENT_ID]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('The fixture payment vanished');
  }
  return row;
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'checkout');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Northwind Supplies')`, [
    MERCHANT_ID,
  ]);
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 46903512, '0xabc', 20)`,
  );
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, callback_url, merchant_reference, metadata
     ) VALUES ($1,$2,'test','polygon-amoy',$3,$4,'USDC',6,
               25000000,25000000,25000000,$5,'confirming',5,true,1000,
               now() + interval '30 minutes',
               'https://hooks.merchant.example/cryptopay','invoice-8841',
               '{"internalCostCentre":"eu-west"}'::jsonb)`,
    [PAYMENT_ID, MERCHANT_ID, CHECKOUT_TOKEN, USDC_AMOY, ACCOUNT],
  );
  await pool.query(
    `INSERT INTO payment_transfers
       (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
        block_reference, source_account, asset_reference, amount, classification, observation)
     VALUES ('trf_01K4QW6ZR2M8X4T7YQ0C3F1001',$1,'polygon-amoy',$2,0,46903512,$3,$4,$5,
             25000000,'credited','observed')`,
    [PAYMENT_ID, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`, SOURCE_ACCOUNT, USDC_AMOY],
  );

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: 'p'.repeat(48),
    WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);
});

afterAll(async () => {
  await server.close();
  await dropDatabase();
});

beforeEach(async () => {
  await pool.query('DELETE FROM payment_evaluation_queue');
});

describe('reading a checkout without a key', () => {
  it('answers with no authentication at all', async () => {
    const response = await getCheckout();
    expect(response.statusCode).toBe(200);
  });

  it('carries what a customer needs to pay', async () => {
    const response = await getCheckout();
    const body = response.json<{
      status: string;
      networkDisplayName: string;
      merchantDisplayName: string;
      receivingAccount: string;
      requestedAmount: { baseUnits: string; display: string };
      requiredConfirmations: number;
      expiresAt: string;
    }>();

    expect(body).toMatchObject({
      status: 'confirming',
      networkDisplayName: 'Polygon Amoy',
      merchantDisplayName: 'Northwind Supplies',
      receivingAccount: ACCOUNT,
      requiredConfirmations: 5,
    });
    expect(body.requestedAmount.baseUnits).toBe('25000000');
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(0);
  });

  /**
   * The token is held by a stranger. Everything on the merchant's side of the arrangement is absent
   * by construction: the presenter names each field it emits rather than spreading the aggregate, so
   * a field added to the domain cannot appear here by accident.
   */
  it.each([
    'merchantId',
    'callbackUrl',
    'metadata',
    'merchantReference',
    'identifier',
    'acceptanceBand',
    'settlementStatus',
  ])('never exposes %s', async (field) => {
    const response = await getCheckout();
    expect(Object.keys(response.json<Record<string, unknown>>())).not.toContain(field);
  });

  it('leaks nothing through a raw scan of the body either', async () => {
    const response = await getCheckout();
    expect(response.body).not.toContain(MERCHANT_ID);
    expect(response.body).not.toContain(PAYMENT_ID);
    expect(response.body).not.toContain('invoice-8841');
    expect(response.body).not.toContain('hooks.merchant.example');
    expect(response.body).not.toContain('eu-west');
  });

  /**
   * The confirmation count and the finality tag are two different guarantees. A customer watching a
   * full bar on a block that is not yet final is being told something untrue.
   */
  it('reports finality separately from the confirmation count', async () => {
    const response = await getCheckout();
    const body = response.json<{ confirmations: number; finalityConfirmed: boolean }>();
    expect(typeof body.finalityConfirmed).toBe('boolean');
    expect(typeof body.confirmations).toBe('number');
  });

  it('shows the transfers received so far', async () => {
    const response = await getCheckout();
    const body = response.json<{
      transfers: { amount: { baseUnits: string }; observation: string }[];
    }>();
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0]?.amount.baseUnits).toBe('25000000');
  });

  it('is never cached, because the status is the whole point', async () => {
    const response = await getCheckout();
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('answers 404 for an unknown token, the same as for a deleted one', async () => {
    const response = await getCheckout('tok_notarealcheckouttokenatallxyz');
    expect(response.statusCode).toBe(404);
  });
});

describe('the browser transaction hint', () => {
  it('accepts a well-formed hint and queues the payment', async () => {
    const response = await sendHint({ transactionReference: `0x${'d'.repeat(64)}` });
    expect(response.statusCode).toBe(202);

    const queued = await pool.query(
      'SELECT payment_id FROM payment_evaluation_queue WHERE payment_id = $1',
      [PAYMENT_ID],
    );
    expect(queued.rowCount).toBe(1);
  });

  /**
   * The claim the whole architecture rests on, asserted rather than stated: a hash the browser
   * invented moves nothing. Amount, asset, recipient and confirmations are re-derived by the scanner
   * from the chain, and this endpoint only schedules a look.
   */
  it('credits nothing, whatever hash it is given', async () => {
    const before = await readPayment();
    await sendHint({ transactionReference: `0x${'f'.repeat(64)}` });
    const after = await readPayment();

    expect(after.credited_amount).toBe(before.credited_amount);
    expect(after.status).toBe(before.status);
    expect(after.status_version).toBe(before.status_version);
  });

  it('records no transfer for a hinted transaction', async () => {
    const countBefore = await pool.query('SELECT count(*)::int AS count FROM payment_transfers');
    await sendHint({ transactionReference: `0x${'e'.repeat(64)}` });
    const countAfter = await pool.query('SELECT count(*)::int AS count FROM payment_transfers');
    expect(countAfter.rows[0]).toEqual(countBefore.rows[0]);
  });

  it('answers 202 rather than 200, so a browser cannot read it as confirmation', async () => {
    expect(await hintStatus({ transactionReference: `0x${'a'.repeat(64)}` })).toBe(202);
  });

  it('refuses a hint that is not a transaction reference', async () => {
    expect(await hintStatus({ transactionReference: 'not-a-hash' })).toBe(422);
    expect(await hintStatus({})).toBe(422);
  });

  it('answers 404 for an unknown checkout', async () => {
    const status = await hintStatus(
      { transactionReference: `0x${'a'.repeat(64)}` },
      'tok_notarealcheckouttokenatallxyz',
    );
    expect(status).toBe(404);
  });

  it('is idempotent: the same hint twice queues the payment once', async () => {
    await sendHint({ transactionReference: `0x${'b'.repeat(64)}` });
    await sendHint({ transactionReference: `0x${'b'.repeat(64)}` });

    const queued = await pool.query('SELECT count(*)::int AS count FROM payment_evaluation_queue');
    expect(queued.rows[0]).toEqual({ count: 1 });
  });
});
