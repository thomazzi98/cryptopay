import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PaymentRepository } from '../src/infrastructure/persistence/payment.repository.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * The outbox is written with the transition, never after it.
 *
 * This is the property the whole notification path rests on. If the delivery row could fail to be
 * written while the payment update succeeded, then "completed, and nobody was told" would be a state
 * the database can hold, and no amount of retrying afterwards would find it: there would be nothing
 * to retry. Committing in PostgreSQL and then enqueuing in a broker has exactly that window, which is
 * why the outbox is a table here rather than a queue somewhere else.
 *
 * The tests force the delivery insert to fail and then check the payment, which is the only way to
 * demonstrate a shared transaction rather than assert one.
 */

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const PAYMENT_ID = 'pay_01K4QW6ZR2M8X4T7YQ0C3D9001';
const DESTINATION = 'https://hooks.merchant.example/cryptopay';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let payments: PaymentRepository;

async function resetPayment(): Promise<void> {
  await pool.query('DELETE FROM webhook_deliveries WHERE payment_id = $1', [PAYMENT_ID]);
  await pool.query('DELETE FROM payment_status_transitions WHERE payment_id = $1', [PAYMENT_ID]);
  await pool.query(`UPDATE payments SET status = 'pending', status_version = 0 WHERE id = $1`, [
    PAYMENT_ID,
  ]);
}

async function loadPayment() {
  const [payment] = await payments.findByIdentifiers([PAYMENT_ID]);
  if (payment === undefined) {
    throw new Error('The fixture payment vanished');
  }
  return payment;
}

async function countDeliveries(eventType: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM webhook_deliveries
      WHERE payment_id = $1 AND event_type = $2`,
    [PAYMENT_ID, eventType],
  );
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'outbox');
  pool = isolated.pool;
  dropDatabase = isolated.drop;
  payments = new PaymentRepository(pool);

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Outbox Fixtures')`, [
    MERCHANT_ID,
  ]);
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
               now() + interval '30 minutes', $3)`,
    [PAYMENT_ID, MERCHANT_ID, DESTINATION],
  );
});

afterAll(async () => {
  await dropDatabase();
});

describe('a transition that carries a callback', () => {
  it('writes the payment and the delivery together', async () => {
    await resetPayment();
    const payment = await loadPayment();

    const saved = await payments.saveTransition({
      payment: { ...payment, status: 'confirming', statusVersion: 1 },
      previousStatus: payment.status,
      expectedVersion: payment.statusVersion,
      command: 'applyLedgerObservation',
      causedBy: 'TRANSFER_CREDITED',
      outbox: {
        identifier: 'whd_01K4QW6ZR2M8X4T7YQ0C3D9101',
        merchantId: MERCHANT_ID,
        environment: 'test',
        eventType: 'payment.confirming',
        destinationUrl: DESTINATION,
        payload: '{"type":"payment.confirming"}',
      },
    });

    expect(saved).toBe(true);
    const after = await loadPayment();
    expect(after.status).toBe('confirming');
    expect(await countDeliveries('payment.confirming')).toBe(1);
  });

  /**
   * The headline assertion. The delivery insert is made to fail by planting a row that collides on
   * the primary key, which the ON CONFLICT clause deliberately does not cover, and the payment must
   * come back unchanged.
   */
  it('rolls the payment back when the delivery cannot be written', async () => {
    await resetPayment();
    const payment = await loadPayment();
    const colliding = 'whd_01K4QW6ZR2M8X4T7YQ0C3D9199';

    await pool.query(
      `INSERT INTO webhook_deliveries
         (id, merchant_id, payment_id, environment, event_type, destination_url, payload)
       VALUES ($1,$2,$3,'test','payment.unrelated',$4,'{}')`,
      [colliding, MERCHANT_ID, PAYMENT_ID, DESTINATION],
    );

    await expect(
      payments.saveTransition({
        payment: { ...payment, status: 'confirming', statusVersion: 1 },
        previousStatus: payment.status,
        expectedVersion: payment.statusVersion,
        command: 'applyLedgerObservation',
        causedBy: 'TRANSFER_CREDITED',
        outbox: {
          identifier: colliding,
          merchantId: MERCHANT_ID,
          environment: 'test',
          eventType: 'payment.confirming',
          destinationUrl: DESTINATION,
          payload: '{}',
        },
      }),
    ).rejects.toThrow();

    const after = await loadPayment();
    expect(after.status).toBe('pending');
    expect(after.statusVersion).toBe(0);
  });

  it('leaves no audit row behind when the delivery could not be written', async () => {
    const transitions = await pool.query(
      'SELECT id FROM payment_status_transitions WHERE payment_id = $1',
      [PAYMENT_ID],
    );
    expect(transitions.rowCount).toBe(0);
  });

  /**
   * A replayed transition loses the compare-and-swap, so the delivery is not written twice. The
   * uniqueness of (payment_id, event_type) is the second line: even a bypassed comparison produces
   * one notification for one fact.
   */
  it('produces one delivery per event however often the transition is replayed', async () => {
    await resetPayment();
    const payment = await loadPayment();
    const outbox = {
      identifier: 'whd_01K4QW6ZR2M8X4T7YQ0C3D9301',
      merchantId: MERCHANT_ID,
      environment: 'test' as const,
      eventType: 'payment.confirming',
      destinationUrl: DESTINATION,
      payload: '{}',
    };
    const moved = { ...payment, status: 'confirming' as const, statusVersion: 1 };
    const transition = {
      payment: moved,
      previousStatus: payment.status,
      expectedVersion: payment.statusVersion,
      command: 'applyLedgerObservation',
      causedBy: 'TRANSFER_CREDITED',
      outbox,
    };

    expect(await payments.saveTransition(transition)).toBe(true);
    expect(await payments.saveTransition(transition)).toBe(false);
    expect(await countDeliveries('payment.confirming')).toBe(1);
  });

  it('writes no delivery for a merchant who supplied no callback url', async () => {
    await resetPayment();
    const payment = await loadPayment();

    const saved = await payments.saveTransition({
      payment: { ...payment, status: 'confirming', statusVersion: 1 },
      previousStatus: payment.status,
      expectedVersion: payment.statusVersion,
      command: 'applyLedgerObservation',
      causedBy: 'TRANSFER_CREDITED',
      outbox: null,
    });

    expect(saved).toBe(true);
    expect(await countDeliveries('payment.confirming')).toBe(0);
  });
});
