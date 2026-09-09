import { decodeQrCode } from '../../src/infrastructure/qr/qr-decoder.test-helper.js';
import type { GatewayPayment } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EvaluatePaymentsUseCase } from '../../src/application/evaluate-payments.use-case.js';
import { ScanNetworkUseCase } from '../../src/application/scan-network.use-case.js';
import { buildApplicationServer } from '../../src/composition-root.js';
import { loadConfiguration } from '../../src/configuration.js';
import type { ApplicationServer } from '../../src/http/server-types.js';
import { TronChainGateway } from '../../src/infrastructure/chain/tron/tron-chain-gateway.js';
import { HttpTronNode } from '../../src/infrastructure/chain/tron/tron-client.js';
import { generateApiKey } from '../../src/infrastructure/crypto/api-key.js';
import { BlockCursorRepository } from '../../src/infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from '../../src/infrastructure/persistence/chain-scan.store.js';
import { EvaluationQueueRepository } from '../../src/infrastructure/persistence/evaluation-queue.repository.js';
import { ObservedBlockRepository } from '../../src/infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from '../../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../../src/infrastructure/persistence/payment-transfer.repository.js';
import { createLocalKeyWrapper } from '../../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../../src/infrastructure/wallet/master-seed.js';
import { WalletSeedRepository } from '../../src/infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from '../../src/infrastructure/system/ulid.js';
import {
  connectionUrlFor,
  createIsolatedDatabase,
} from '../../test/setup/postgres.global-setup.js';
import {
  accountFor,
  genesisAccount,
  isNodeRunning,
  readGenesisIdentity,
  readHeadHeight,
  sendTrx,
  TRON_NODE_BASE_URL,
  type FundedAccount,
} from '../setup/tron-node.js';

/**
 * A TRON payment from creation to completion, against a real TRON node.
 *
 * The chain here is a local single-witness java-tron, not the public network, and the difference is
 * stated rather than glossed: there are no peers, so nothing about reorganisation, propagation or
 * rate limiting is exercised. What is exercised is everything else, and all of it for real. The
 * node encodes and validates the transactions, checks the signatures, produces the blocks and
 * answers over the same TronGrid-compatible HTTP surface the adapter uses in production. Nothing in
 * this file tells the API a payment was made: a transfer is broadcast and the workers are ticked.
 *
 * Skipped when the node is not running, with the command printed. `npm run test:tron-local` after
 * `docker run -d -p 9090:9090 --name cryptopay-tre tronbox/tre`.
 */

const PEPPER = 't'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 13);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3T1001';
const NETWORK = 'tron-nile';
const FENCING_TOKEN = 1n;
/** What `tron-nile` policy demands, and what this test therefore has to produce locally. */
const REQUIRED_CONFIRMATIONS = 19;
const SUN_PER_TRX = 1_000_000n;

/**
 * Probed at module load rather than in `beforeAll`, because `describe.skipIf` is evaluated while the
 * file is being collected and a flag set later is always still false by then. That mistake skips the
 * whole suite silently, which looks exactly like passing.
 */
const nodeIsRunning = await isNodeRunning();

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let gateway: TronChainGateway;
let scanner: ScanNetworkUseCase;
let payments: PaymentRepository;
let genesis: FundedAccount;
let testKey = '';
let currentTime = new Date('2026-09-07T12:00:00.000Z');

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let referenceCounter = 0;

/**
 * The node produces a block only when there is a transaction to put in it, which makes confirmation
 * counting exact rather than a race against a timer. A one-sun transfer is therefore how this suite
 * advances the chain, and it goes to a ballast account rather than back to the sender because TRON
 * rejects a transfer to yourself outright.
 */
const BALLAST_ACCOUNT = accountFor(
  Uint8Array.from({ length: 32 }, (_unused, index) => index + 101),
);

async function mineBlocks(count: number): Promise<void> {
  for (let mined = 0; mined < count; mined += 1) {
    await sendTrx(genesis, BALLAST_ACCOUNT, 1n);
  }
}

/**
 * A callback URL is supplied because a merchant who gives none is polling instead, and the outbox
 * deliberately writes no delivery row for them. Asserting a completion is published needs a payment
 * that asked to be told.
 */
const CALLBACK_URL = 'https://merchant.example.com/hooks/cryptopay';

function createPayment(currency: string, amount: string) {
  referenceCounter += 1;
  return server.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: {
      authorization: `Bearer ${testKey}`,
      'content-type': 'application/json',
      'idempotency-key': `tron-local-${referenceCounter}`,
    },
    payload: {
      externalReference: `order_${referenceCounter}`,
      network: 'tron',
      currency,
      amount,
      expiresIn: 1800,
      callbackUrl: CALLBACK_URL,
    },
  });
}

function evaluator(workerIdentity: string): EvaluatePaymentsUseCase {
  return new EvaluatePaymentsUseCase({
    gateway,
    paymentRepository: payments,
    paymentTransferRepository: new PaymentTransferRepository(pool),
    evaluationQueueRepository: new EvaluationQueueRepository(pool),
    now: () => currentTime,
    workerIdentity,
    ulidFactory,
    checkoutBaseUrl: 'https://pay.cryptopay.test',
  });
}

/** One turn of the whole loop: observe the chain, then decide what it means. */
async function tick(): Promise<void> {
  await scanner.execute(FENCING_TOKEN);
  await evaluator('worker-a').execute();
}

async function readPaymentRow(paymentId: string) {
  const result = await pool.query<{
    status: string;
    credited_amount: string;
    confirmations_observed: number;
    finality_confirmed: boolean;
    completed_at: Date | null;
  }>(
    `SELECT status, credited_amount, confirmations_observed, finality_confirmed, completed_at
       FROM payments WHERE id = $1`,
    [paymentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No payment ${paymentId}`);
  }
  return row;
}

async function transfersFor(paymentId: string) {
  const result = await pool.query<{
    transaction_reference: string;
    amount: string;
    source_account: string;
    asset_reference: string;
    classification: string;
    observation: string;
  }>(
    `SELECT transaction_reference, amount, source_account, asset_reference, classification,
            observation
       FROM payment_transfers WHERE payment_id = $1 ORDER BY observed_at`,
    [paymentId],
  );
  return result.rows;
}

async function transitionsFor(paymentId: string): Promise<string[]> {
  const result = await pool.query<{ to_status: string }>(
    `SELECT to_status FROM payment_status_transitions WHERE payment_id = $1 ORDER BY to_version`,
    [paymentId],
  );
  return result.rows.map((row) => row.to_status);
}

/** Drives one payment to completion and returns its row, so each scenario reads as one story. */
async function settle(paymentId: string): Promise<Awaited<ReturnType<typeof readPaymentRow>>> {
  await tick();
  await mineBlocks(REQUIRED_CONFIRMATIONS + 1);
  await tick();
  return readPaymentRow(paymentId);
}

async function placeCursorAtTip(): Promise<void> {
  const height = await readHeadHeight();
  const progress = await gateway.readPositionAtHeight(BigInt(height));
  const reference = progress.kind === 'found' ? progress.position.reference : '';
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range,
        fencing_token)
     VALUES ($1, $2, $3, 100, $4)
     ON CONFLICT (network_identifier) DO UPDATE
       SET last_scanned_height = EXCLUDED.last_scanned_height,
           last_scanned_reference = EXCLUDED.last_scanned_reference,
           consecutive_successes = 0,
           halted_at = NULL,
           halted_reason = NULL`,
    [NETWORK, height.toString(), reference, FENCING_TOKEN.toString()],
  );
  await pool.query('DELETE FROM observed_blocks WHERE network_identifier = $1', [NETWORK]);
  await pool.query('DELETE FROM payment_evaluation_queue');
  // A payment left live by an earlier scenario would be evaluated by this one and counted against
  // its budget, so each test starts with only its own live set.
  await pool.query(
    `UPDATE payments SET status = 'canceled'
      WHERE network_identifier = $1 AND status IN ('pending', 'partially_funded', 'confirming')`,
    [NETWORK],
  );
}

beforeAll(async () => {
  if (!nodeIsRunning) {
    return;
  }

  genesis = genesisAccount();
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'tronlocal');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [
    MERCHANT_ID,
    'TRON Local Fixtures',
  ]);

  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  await new WalletSeedRepository(pool).storeIfAbsent(
    `sed_${ulidFactory.create(1_757_183_400_001)}`,
    'test',
    sealSeed(generateMasterSeed(), 'test', wrapper),
  );

  gateway = new TronChainGateway({
    networkIdentifier: NETWORK,
    node: new HttpTronNode({
      baseUrl: TRON_NODE_BASE_URL,
      apiKey: null,
      timeoutMilliseconds: 30_000,
    }),
    // The local chain has its own genesis, and the adapter refuses to scan a chain that is not the
    // one it was configured for. Reading it rather than hardcoding it is what keeps that guard real.
    expectedLedgerIdentity: await readGenesisIdentity(),
  });

  payments = new PaymentRepository(pool);
  scanner = new ScanNetworkUseCase({
    gateway,
    paymentRepository: payments,
    paymentTransferRepository: new PaymentTransferRepository(pool),
    blockCursorRepository: new BlockCursorRepository(pool),
    observedBlockRepository: new ObservedBlockRepository(pool),
    chainScanStore: new ChainScanStore(pool),
    ulidFactory,
    now: () => currentTime,
  });

  const configuration = loadConfiguration({
    NODE_ENV: 'test',
    DATABASE_URL: connectionUrlFor(isolated.databaseName, inject('postgresPort')),
    API_KEY_PEPPER: PEPPER,
    WALLET_KEY_ENCRYPTION_KEY: WALLET_KEY.toString('base64'),
    API_RATE_LIMIT_REQUESTS: '5000',
    API_RATE_LIMIT_WINDOW_SECONDS: '60',
  });
  server = buildApplicationServer(configuration, pino({ level: 'silent' }), pool);

  keyCounter += 1;
  const generated = generateApiKey('test', PEPPER, ulidFactory, keyCounter);
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label, scopes)
     VALUES ($1, $2, 'test', $3, $4, 'tron-local', $5::text[])`,
    [
      generated.keyIdentifier,
      MERCHANT_ID,
      generated.secretDigest,
      generated.lastFour,
      ['payments:read', 'payments:write'],
    ],
  );
  testKey = generated.presentedKey;
});

afterAll(async () => {
  if (!nodeIsRunning) {
    return;
  }
  await server.close();
  await dropDatabase();
});

beforeEach(async () => {
  if (!nodeIsRunning) {
    return;
  }
  currentTime = new Date('2026-09-07T12:00:00.000Z');
  await placeCursorAtTip();
});

describe.skipIf(!nodeIsRunning)('a TRX payment nobody told the API about', () => {
  it('is created with a destination the chain itself accepts', async () => {
    const response = await createPayment('TRX', '5.000000');
    const payment = response.json<GatewayPayment>();

    expect(response.statusCode).toBe(201);
    expect(payment.paymentDestination.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(payment.paymentUri).toBe(`tron:${payment.paymentDestination.address}?amount=5000000`);

    const image = payment.qrCode ?? '';
    const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    expect(decodeQrCode(bytes)).toBe(payment.paymentUri);

    // The chain's own answer about the address, which is the only opinion that matters. A malformed
    // destination is refused here rather than accepted and paid into.
    await expect(gateway.readNativeBalance(payment.paymentDestination.address)).resolves.toBe(0n);
  });

  it('reaches completed from a real transfer, and records what paid it', async () => {
    const created = await createPayment('TRX', '5.000000');
    const payment = created.json<GatewayPayment>();
    const destination = payment.paymentDestination.address;

    const transactionId = await sendTrx(genesis, destination, 5n * SUN_PER_TRX);
    const row = await settle(payment.id);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('5000000');
    expect(row.finality_confirmed).toBe(true);
    expect(row.completed_at).not.toBeNull();

    const [transfer] = await transfersFor(payment.id);
    expect(transfer?.transaction_reference).toBe(transactionId);
    expect(transfer?.amount).toBe('5000000');
    expect(transfer?.source_account).toBe(genesis.account);
    expect(transfer?.asset_reference).toBe('native');
    expect(transfer?.classification).toBe('credited');
  });

  it('leaves an audit trail of exactly the transitions it took', async () => {
    const created = await createPayment('TRX', '2.000000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 2n * SUN_PER_TRX);
    await settle(payment.id);

    expect(await transitionsFor(payment.id)).toEqual(['confirming', 'completed']);
  });

  it('publishes the completion for the merchant to be told about', async () => {
    const created = await createPayment('TRX', '3.000000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 3n * SUN_PER_TRX);
    await settle(payment.id);

    const published = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM webhook_deliveries WHERE payment_id = $1`,
      [payment.id],
    );
    expect(published.rows.map((row) => row.event_type)).toContain('payment.completed');
  });

  it('reports the payment as PAID to whoever asks next', async () => {
    const created = await createPayment('TRX', '1.500000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 1_500_000n);
    await settle(payment.id);

    const viewed = await server.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    const settled = viewed.json<GatewayPayment>();

    expect(settled.status).toBe('PAID');
    expect(settled.amountReceived).toBe('1.500000');
    expect(settled.transactions[0]?.status).toBe('CONFIRMED');
    expect(settled.transactions[0]?.explorerUrl).toContain(
      settled.transactions[0]?.reference ?? '',
    );
  });
});

describe.skipIf(!nodeIsRunning)('what the chain says that the payment did not ask for', () => {
  it('does not credit a transfer to somebody else', async () => {
    const created = await createPayment('TRX', '4.000000');
    const payment = created.json<GatewayPayment>();
    const stranger = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 1));

    await sendTrx(genesis, stranger, 4n * SUN_PER_TRX);
    await tick();

    const current = await readPaymentRow(payment.id);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.id)).toHaveLength(0);
  });

  /**
   * No confirmations are produced here. An underpaid payment stays partially funded however long the
   * chain runs, so mining nineteen blocks to prove it would cost two minutes to assert nothing.
   */
  it('reports an underpayment rather than completing it', async () => {
    const created = await createPayment('TRX', '6.000000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 5n * SUN_PER_TRX);
    await tick();

    const row = await readPaymentRow(payment.id);
    expect(row.status).toBe('partially_funded');
    expect(row.credited_amount).toBe('5000000');
  });

  it('completes an overpayment and records the whole amount received', async () => {
    const created = await createPayment('TRX', '2.000000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 3n * SUN_PER_TRX);
    const row = await settle(payment.id);

    expect(row.status).toBe('overpaid');
    expect(row.credited_amount).toBe('3000000');
  });

  it('sums two transfers that together pay the amount', async () => {
    const created = await createPayment('TRX', '4.000000');
    const payment = created.json<GatewayPayment>();
    const destination = payment.paymentDestination.address;

    await sendTrx(genesis, destination, 1n * SUN_PER_TRX);
    await tick();
    const current = await readPaymentRow(payment.id);
    expect(current.status).toBe('partially_funded');

    await sendTrx(genesis, destination, 3n * SUN_PER_TRX);
    const row = await settle(payment.id);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('4000000');
    expect(await transfersFor(payment.id)).toHaveLength(2);
  });

  /**
   * The scan window is replayed on every crash, so a transfer being seen twice is the normal case
   * rather than the exceptional one. Crediting it twice would double the merchant's money.
   */
  it('credits one transfer once, however many times it is scanned', async () => {
    const created = await createPayment('TRX', '2.500000');
    const payment = created.json<GatewayPayment>();

    await sendTrx(genesis, payment.paymentDestination.address, 2_500_000n);
    await tick();

    const creditedOnce = await readPaymentRow(payment.id);
    await placeCursorAtTipWithoutRetiring();
    await tick();
    await tick();

    const afterReplay = await readPaymentRow(payment.id);
    expect(afterReplay.credited_amount).toBe(creditedOnce.credited_amount);
    expect(await transfersFor(payment.id)).toHaveLength(1);
  });
});

/** Rewinds the cursor without cancelling live payments, so a replay can be observed. */
async function placeCursorAtTipWithoutRetiring(): Promise<void> {
  const height = await readHeadHeight();
  await pool.query(
    `UPDATE block_cursors
        SET last_scanned_height = GREATEST($2::bigint - 30, 0), consecutive_successes = 0
      WHERE network_identifier = $1`,
    [NETWORK, height.toString()],
  );
  await pool.query('DELETE FROM observed_blocks WHERE network_identifier = $1', [NETWORK]);
}
