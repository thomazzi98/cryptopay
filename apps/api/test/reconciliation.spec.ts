import type { NetworkIdentifier } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ReconcilePaymentsUseCase } from '../src/application/reconcile-payments.use-case.js';
import type {
  ChainGateway,
  TransferReconciliation,
} from '../src/application/ports/chain-gateway.port.js';
import { EvaluationQueueRepository } from '../src/infrastructure/persistence/evaluation-queue.repository.js';
import { PaymentRepository } from '../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../src/infrastructure/persistence/payment-transfer.repository.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Reconciliation against a real database.
 *
 * The scanner is deliberately absent from these tests. Every one of them describes a state the
 * scanner could have produced and then failed to correct: a transfer recorded and later removed by
 * a reorganisation nobody looked at again, and money sitting at a destination that no scan ever saw.
 * Both are invisible to the code that produced them, which is the entire reason this worker exists.
 */

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3R1001';
const NETWORK: NetworkIdentifier = 'polygon-amoy';
const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';
const BLOCK = `0x${'b'.repeat(64)}`;
const REPLACEMENT_BLOCK = `0x${'c'.repeat(64)}`;

let pool: Pool;
let dropDatabase: () => Promise<void>;
let payments: PaymentRepository;
let transfers: PaymentTransferRepository;
let queue: EvaluationQueueRepository;

let paymentCounter = 0;
let balances: Map<string, bigint>;
let verdicts: Map<string, TransferReconciliation>;
let balanceReadsFailFor: Set<string>;

function accountFor(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

async function insertPayment(options: {
  readonly account: string;
  readonly credited: string;
  readonly status?: string;
}): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3R${paymentCounter.toString().padStart(4, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, credited_amount, completed_at
     ) VALUES ($1,$2,'test',$3::network_identifier,$1,$4,'USDC',6,
               25000000,25000000,25000000,$5,$6::payment_status,5,true,1000,
               now() + interval '30 minutes', $7, $8)`,
    [
      id,
      MERCHANT_ID,
      NETWORK,
      USDC_AMOY,
      options.account,
      options.status ?? 'confirming',
      options.credited,
      options.status === 'completed' ? new Date() : null,
    ],
  );
  return id;
}

async function insertTransfer(options: {
  readonly paymentId: string;
  readonly reference: string;
  readonly amount: string;
  readonly blockHeight: number;
}): Promise<string> {
  const id = `trf_01K4QW6ZR2M8X4T7YQ0C3R${options.reference.slice(-4)}`;
  await pool.query(
    `INSERT INTO payment_transfers
       (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
        block_reference, source_account, asset_reference, amount, classification, observation)
     VALUES ($1,$2,$3::network_identifier,$4,0,$5,$6,$7,$8,$9,'credited','observed')`,
    [
      id,
      options.paymentId,
      NETWORK,
      options.reference,
      options.blockHeight,
      BLOCK,
      accountFor(9999),
      USDC_AMOY,
      options.amount,
    ],
  );
  return id;
}

/**
 * A gateway that answers from the maps above. Reconciliation is about disagreement between the
 * database and the chain, so the chain's answers have to be controllable; every other part of the
 * path is real.
 */
function gateway(): ChainGateway {
  return {
    networkIdentifier: NETWORK,
    supportsFinalityTag: true,
    assertLedgerIdentity: () => Promise.resolve(),
    readChainProgress: () =>
      Promise.resolve({
        tip: { height: 2000n, reference: BLOCK },
        finalizedHeight: 1900n,
        observedAtMilliseconds: 0,
      }),
    confirmFinalizedHeight: () => Promise.resolve('confirmed' as const),
    readPositionAtHeight: () => Promise.resolve({ kind: 'absent' as const }),
    scanIncomingTransfers: () =>
      Promise.resolve({
        scannedThrough: { position: { height: 1900n, reference: BLOCK }, parentReference: BLOCK },
        headers: [],
        transfers: [],
      }),
    reconcileTransfer: (reference) =>
      Promise.resolve(
        verdicts.get(reference.transactionReference) ?? {
          kind: 'present' as const,
          position: { height: 1500n, reference: BLOCK },
        },
      ),
    readAssetBalance: (account) => {
      if (balanceReadsFailFor.has(account)) {
        return Promise.reject(new Error('the endpoint did not answer'));
      }
      return Promise.resolve(balances.get(account) ?? 0n);
    },
    readNativeBalance: () => Promise.resolve(0n),
  };
}

function reconciler(): ReconcilePaymentsUseCase {
  return new ReconcilePaymentsUseCase({
    gateway: gateway(),
    paymentRepository: payments,
    paymentTransferRepository: transfers,
    evaluationQueueRepository: queue,
    now: () => new Date(),
  });
}

async function queuedPayments(): Promise<string[]> {
  const result = await pool.query<{ payment_id: string }>(
    'SELECT payment_id FROM payment_evaluation_queue ORDER BY payment_id',
  );
  return result.rows.map((row) => row.payment_id);
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'reconciliation');
  pool = isolated.pool;
  dropDatabase = isolated.drop;
  payments = new PaymentRepository(pool);
  transfers = new PaymentTransferRepository(pool);
  queue = new EvaluationQueueRepository(pool);

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [
    MERCHANT_ID,
    'Reconciliation Fixtures',
  ]);
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  balances = new Map<string, bigint>();
  verdicts = new Map<string, TransferReconciliation>();
  balanceReadsFailFor = new Set<string>();
  await pool.query('DELETE FROM payment_evaluation_queue');
  await pool.query('DELETE FROM payment_transfers');
  await pool.query('DELETE FROM payments');
});

describe('re-checking transfers this system already recorded', () => {
  it('withdraws a transfer the chain no longer knows, and asks for the payment to be re-decided', async () => {
    const account = accountFor(1);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'1'.repeat(64)}`;
    const transferId = await insertTransfer({
      paymentId,
      reference,
      amount: '25000000',
      blockHeight: 1500,
    });
    verdicts.set(reference, { kind: 'orphaned' });

    const outcome = await reconciler().execute();

    expect(outcome.checkedTransfers).toBe(1);
    expect(outcome.orphanedTransfers).toBe(1);
    expect(await queuedPayments()).toEqual([paymentId]);

    const stored = await pool.query<{ observation: string }>(
      'SELECT observation FROM payment_transfers WHERE id = $1',
      [transferId],
    );
    expect(stored.rows[0]?.observation).toBe('orphaned');
  });

  /**
   * A transaction that moved to a block with a different identifier is the same money in a
   * different history. It is withdrawn for the same reason a missing one is.
   */
  it('withdraws a transfer that now sits in a different block', async () => {
    const account = accountFor(2);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'2'.repeat(64)}`;
    await insertTransfer({ paymentId, reference, amount: '25000000', blockHeight: 1500 });
    verdicts.set(reference, {
      kind: 'present',
      position: { height: 1501n, reference: REPLACEMENT_BLOCK },
    });

    const outcome = await reconciler().execute();
    expect(outcome.orphanedTransfers).toBe(1);
  });

  it('leaves a transfer that is still exactly where it was', async () => {
    const account = accountFor(3);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'3'.repeat(64)}`;
    await insertTransfer({ paymentId, reference, amount: '25000000', blockHeight: 1500 });

    const outcome = await reconciler().execute();

    expect(outcome.checkedTransfers).toBe(1);
    expect(outcome.orphanedTransfers).toBe(0);
    expect(await queuedPayments()).toEqual([]);
  });

  /**
   * "I do not know" must never be recorded as "it is gone". An endpoint that cannot answer would
   * otherwise withdraw every transfer on the network during an outage.
   */
  it('leaves a transfer alone when the endpoint cannot answer', async () => {
    const account = accountFor(4);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'4'.repeat(64)}`;
    await insertTransfer({ paymentId, reference, amount: '25000000', blockHeight: 1500 });
    verdicts.set(reference, { kind: 'indeterminate' });

    const outcome = await reconciler().execute();

    expect(outcome.orphanedTransfers).toBe(0);
    expect(await queuedPayments()).toEqual([]);
  });

  /**
   * Above the finalized height the scanner is still working and a disagreement is ordinary. Asking
   * there would report churn as damage.
   */
  it('does not question a transfer above the finalized height', async () => {
    const account = accountFor(5);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'5'.repeat(64)}`;
    await insertTransfer({ paymentId, reference, amount: '25000000', blockHeight: 1950 });
    verdicts.set(reference, { kind: 'orphaned' });

    const outcome = await reconciler().execute();
    expect(outcome.checkedTransfers).toBe(0);
    expect(outcome.orphanedTransfers).toBe(0);
  });

  it('withdraws a transfer once, however many passes run', async () => {
    const account = accountFor(6);
    const paymentId = await insertPayment({ account, credited: '25000000' });
    const reference = `0x${'6'.repeat(64)}`;
    await insertTransfer({ paymentId, reference, amount: '25000000', blockHeight: 1500 });
    verdicts.set(reference, { kind: 'orphaned' });

    const first = await reconciler().execute();
    const second = await reconciler().execute();

    expect(first.orphanedTransfers).toBe(1);
    expect(second.orphanedTransfers).toBe(0);
  });
});

describe('comparing a destination balance with what was credited', () => {
  /**
   * The scenario the whole worker exists for: money arrived, no scan ever saw it, and nothing in
   * the scanning path will ever notice. The balance read is an independent question, so it can see
   * what the log query missed.
   */
  it('notices money at a destination that no scan ever credited', async () => {
    const account = accountFor(10);
    const paymentId = await insertPayment({ account, credited: '0' });
    balances.set(account, 25_000_000n);

    const outcome = await reconciler().execute();

    expect(outcome.checkedAccounts).toBe(1);
    expect(outcome.discrepancies).toBe(1);
    expect(outcome.requeued).toBe(1);
    expect(await queuedPayments()).toEqual([paymentId]);
  });

  it('says nothing when the balance matches what was credited', async () => {
    const account = accountFor(11);
    await insertPayment({ account, credited: '25000000' });
    balances.set(account, 25_000_000n);

    const outcome = await reconciler().execute();

    expect(outcome.discrepancies).toBe(0);
    expect(await queuedPayments()).toEqual([]);
  });

  /**
   * A balance below the credited total is the ordinary state of a swept destination and of any
   * account a merchant spends from. Reporting it would produce a permanent false alarm.
   */
  it('does not report a balance lower than the credited total', async () => {
    const account = accountFor(12);
    await insertPayment({ account, credited: '25000000' });
    balances.set(account, 0n);

    const outcome = await reconciler().execute();
    expect(outcome.discrepancies).toBe(0);
  });

  it('ignores a terminal payment, whose destination holds money awaiting settlement', async () => {
    const account = accountFor(13);
    await insertPayment({ account, credited: '25000000', status: 'completed' });
    balances.set(account, 99_000_000n);

    const outcome = await reconciler().execute();

    expect(outcome.checkedAccounts).toBe(0);
    expect(outcome.discrepancies).toBe(0);
  });

  it('skips a destination whose balance cannot be read rather than guessing', async () => {
    const account = accountFor(14);
    await insertPayment({ account, credited: '0' });
    balanceReadsFailFor.add(account);

    const outcome = await reconciler().execute();

    expect(outcome.checkedAccounts).toBe(1);
    expect(outcome.discrepancies).toBe(0);
  });

  /**
   * Repairs go through the ordinary evaluation path. Nothing here writes a status, and a second
   * pass over an already-queued payment does not queue it twice.
   */
  it('never writes a payment status itself, and does not queue the same payment twice', async () => {
    const account = accountFor(15);
    const paymentId = await insertPayment({ account, credited: '0' });
    balances.set(account, 25_000_000n);

    const first = await reconciler().execute();
    const second = await reconciler().execute();

    expect(first.requeued).toBe(1);
    expect(second.requeued).toBe(0);
    expect(await queuedPayments()).toEqual([paymentId]);

    const stored = await pool.query<{ status: string; credited_amount: string }>(
      'SELECT status, credited_amount FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(stored.rows[0]?.status).toBe('confirming');
    expect(stored.rows[0]?.credited_amount).toBe('0');
  });

  /**
   * Every destination is looked at before any is looked at twice, so a backlog drains rather than
   * the same rows being re-read forever.
   */
  it('works through the destinations rather than re-reading the same ones', async () => {
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await insertPayment({ account: accountFor(20 + index), credited: '0' }));
    }

    await reconciler().execute();
    const marked = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments WHERE reconciled_at IS NOT NULL`,
    );
    expect(marked.rows[0]?.count).toBe(String(created.length));
  });
});
