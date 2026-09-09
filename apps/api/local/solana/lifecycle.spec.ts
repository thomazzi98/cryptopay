import type { GatewayPayment } from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EvaluatePaymentsUseCase } from '../../src/application/evaluate-payments.use-case.js';
import { ScanNetworkUseCase } from '../../src/application/scan-network.use-case.js';
import { buildApplicationServer } from '../../src/composition-root.js';
import { loadConfiguration } from '../../src/configuration.js';
import type { ApplicationServer } from '../../src/http/server-types.js';
import { SolanaChainGateway } from '../../src/infrastructure/chain/solana/solana-chain-gateway.js';
import { HttpSolanaNode } from '../../src/infrastructure/chain/solana/solana-client.js';
import { generateApiKey } from '../../src/infrastructure/crypto/api-key.js';
import { BlockCursorRepository } from '../../src/infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from '../../src/infrastructure/persistence/chain-scan.store.js';
import { EvaluationQueueRepository } from '../../src/infrastructure/persistence/evaluation-queue.repository.js';
import { ObservedBlockRepository } from '../../src/infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from '../../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../../src/infrastructure/persistence/payment-transfer.repository.js';
import { WalletSeedRepository } from '../../src/infrastructure/persistence/wallet-seed.repository.js';
import { decodeQrCode } from '../../src/infrastructure/qr/qr-decoder.test-helper.js';
import { UlidFactory } from '../../src/infrastructure/system/ulid.js';
import { createLocalKeyWrapper } from '../../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../../src/infrastructure/wallet/master-seed.js';
import {
  connectionUrlFor,
  createIsolatedDatabase,
} from '../../test/setup/postgres.global-setup.js';
import { randomKeypair, SolanaTestNode, type SolanaKeypair } from '../setup/solana-node.js';

/**
 * A SOL payment from creation to completion, against a real Solana validator.
 *
 * The validator is a local single-node `agave-validator`, not devnet, and the difference is stated
 * rather than glossed: one node reaches its own consensus with nobody to disagree, so nothing here
 * exercises a skipped slot, a fork, or a public endpoint's rate limit. Everything else is real. The
 * validator does the transaction deserialisation, the ed25519 signature verification, the runtime
 * execution and the slot finalisation, and answers over the same JSON-RPC surface the adapter uses
 * in production. Nothing in this file tells the API a payment was made.
 *
 * Skipped when no validator answers. `npm run test:solana-local` after
 * `docker run -d -p 8899:8899 anzaxyz/agave:v2.1.14 agave-test-validator`.
 */

const PEPPER = 's'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 17);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3S1001';
const NETWORK = 'solana-devnet';
const FENCING_TOKEN = 1n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const node = new SolanaTestNode(process.env['SOLANA_LOCAL_RPC_URL'] ?? 'http://127.0.0.1:8899');

/**
 * Probed at module load rather than in `beforeAll`, because `describe.skipIf` is evaluated while the
 * file is being collected. A flag set later is still false by then, and the whole suite skips
 * silently, which looks exactly like passing.
 */
const nodeIsRunning = await node.isRunning();

let pool: Pool;
let dropDatabase: () => Promise<void>;
let server: ApplicationServer;
let gateway: SolanaChainGateway;
let scanner: ScanNetworkUseCase;
let payments: PaymentRepository;
let funder: SolanaKeypair;
let testKey = '';
let currentTime = new Date('2026-09-07T12:00:00.000Z');

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let referenceCounter = 0;

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
      'idempotency-key': `solana-local-${referenceCounter}`,
    },
    payload: {
      externalReference: `order_${referenceCounter}`,
      network: 'solana',
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

async function tick(): Promise<void> {
  await scanner.execute(FENCING_TOKEN);
  await evaluator('worker-a').execute();
}

async function readPaymentRow(paymentId: string) {
  const result = await pool.query<{
    status: string;
    credited_amount: string;
    finality_confirmed: boolean;
    completed_at: Date | null;
  }>(
    `SELECT status, credited_amount, finality_confirmed, completed_at
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
  }>(
    `SELECT transaction_reference, amount, source_account, asset_reference, classification
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

/**
 * Scanning reads finalized slots only, so a transfer is invisible until finalisation catches up with
 * the slot that carried it. Ticking until the cursor passes it is the honest wait; a fixed sleep
 * would either be flaky or slower than it needs to be.
 */
async function settle(paymentId: string): Promise<Awaited<ReturnType<typeof readPaymentRow>>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await tick();
    const row = await readPaymentRow(paymentId);
    if (row.status !== 'pending') {
      // One more turn, so a payment that has just been credited can also be completed.
      await tick();
      return readPaymentRow(paymentId);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return readPaymentRow(paymentId);
}

async function placeCursorAtFinalizedHead(): Promise<void> {
  const progress = await gateway.readChainProgress();
  const height = progress.finalizedHeight ?? progress.tip.height;
  const found = await gateway.readPositionAtHeight(height);
  const reference = found.kind === 'found' ? found.position.reference : progress.tip.reference;
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

  funder = randomKeypair();
  const signature = await node.airdrop(funder.account, 100n * LAMPORTS_PER_SOL);
  await node.awaitFinalized(signature);

  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'solanalocal');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [
    MERCHANT_ID,
    'Solana Local Fixtures',
  ]);

  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  await new WalletSeedRepository(pool).storeIfAbsent(
    `sed_${ulidFactory.create(1_757_183_400_001)}`,
    'test',
    sealSeed(generateMasterSeed(), 'test', wrapper),
  );

  gateway = new SolanaChainGateway({
    networkIdentifier: NETWORK,
    node: new HttpSolanaNode({ endpoint: node.url, timeoutMilliseconds: 30_000 }),
    // A local validator has its own genesis, and the adapter refuses to scan a chain that is not the
    // one it was configured for. Reading it rather than hardcoding it keeps that guard real.
    expectedLedgerIdentity: await node.genesisIdentity(),
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
     VALUES ($1, $2, 'test', $3, $4, 'solana-local', $5::text[])`,
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
  await placeCursorAtFinalizedHead();
});

describe.skipIf(!nodeIsRunning)('a SOL payment nobody told the API about', () => {
  it('is created with a destination the validator itself accepts', async () => {
    const response = await createPayment('SOL', '0.500000000');
    const payment = response.json<GatewayPayment>();

    expect(response.statusCode).toBe(201);
    expect(payment.chainId).toBeNull();
    expect(payment.paymentUri).toBe(`solana:${payment.paymentDestination.address}?amount=0.5`);

    const image = payment.qrCode ?? '';
    const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
    expect(decodeQrCode(bytes)).toBe(payment.paymentUri);

    // The validator's own answer about the address, which is the only opinion that matters.
    await expect(node.balance(payment.paymentDestination.address)).resolves.toBe(0n);
  });

  it('reaches completed from a real transfer, and records what paid it', async () => {
    const created = await createPayment('SOL', '0.500000000');
    const payment = created.json<GatewayPayment>();
    const destination = payment.paymentDestination.address;

    const signature = await node.transferLamports(funder, destination, LAMPORTS_PER_SOL / 2n);
    const row = await settle(payment.id);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('500000000');
    expect(row.finality_confirmed).toBe(true);

    const [transfer] = await transfersFor(payment.id);
    expect(transfer?.transaction_reference).toBe(signature);
    expect(transfer?.amount).toBe('500000000');
    expect(transfer?.asset_reference).toBe('native');
    expect(transfer?.classification).toBe('credited');

    /**
     * Solana does not name a sender the way an EVM log does. One transaction may debit several
     * accounts, so the adapter deliberately records the credited account rather than guessing which
     * debit was the payment. Asserting the funder here would be asserting EVM semantics on a chain
     * that does not have them, so what is asserted is the documented behaviour.
     */
    expect(transfer?.source_account).toBe(destination);
  });

  it('leaves an audit trail of exactly the transitions it took', async () => {
    const created = await createPayment('SOL', '0.250000000');
    const payment = created.json<GatewayPayment>();

    await node.transferLamports(funder, payment.paymentDestination.address, 250_000_000n);
    await settle(payment.id);

    expect(await transitionsFor(payment.id)).toEqual(['confirming', 'completed']);
  });

  it('publishes the completion for the merchant to be told about', async () => {
    const created = await createPayment('SOL', '0.100000000');
    const payment = created.json<GatewayPayment>();

    await node.transferLamports(funder, payment.paymentDestination.address, 100_000_000n);
    await settle(payment.id);

    const published = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM webhook_deliveries WHERE payment_id = $1`,
      [payment.id],
    );
    expect(published.rows.map((row) => row.event_type)).toContain('payment.completed');
  });

  it('reports the payment as PAID to whoever asks next', async () => {
    const created = await createPayment('SOL', '0.200000000');
    const payment = created.json<GatewayPayment>();

    await node.transferLamports(funder, payment.paymentDestination.address, 200_000_000n);
    await settle(payment.id);

    const viewed = await server.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    const settled = viewed.json<GatewayPayment>();

    expect(settled.status).toBe('PAID');
    expect(settled.amountReceived).toBe('0.200000000');
    expect(settled.transactions[0]?.status).toBe('CONFIRMED');
  });
});

describe.skipIf(!nodeIsRunning)('what the validator says that the payment did not ask for', () => {
  it('does not credit a transfer to somebody else', async () => {
    const created = await createPayment('SOL', '0.300000000');
    const payment = created.json<GatewayPayment>();
    const stranger = randomKeypair();

    const signature = await node.transferLamports(funder, stranger.account, 300_000_000n);
    await node.awaitFinalized(signature);
    await tick();
    await tick();

    const current = await readPaymentRow(payment.id);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.id)).toHaveLength(0);
  });

  it('reports an underpayment rather than completing it', async () => {
    const created = await createPayment('SOL', '0.400000000');
    const payment = created.json<GatewayPayment>();

    await node.transferLamports(funder, payment.paymentDestination.address, 300_000_000n);
    const row = await settle(payment.id);

    expect(row.status).toBe('partially_funded');
    expect(row.credited_amount).toBe('300000000');
  });

  it('completes an overpayment and records the whole amount received', async () => {
    const created = await createPayment('SOL', '0.100000000');
    const payment = created.json<GatewayPayment>();

    await node.transferLamports(funder, payment.paymentDestination.address, 250_000_000n);
    const row = await settle(payment.id);

    expect(row.status).toBe('overpaid');
    expect(row.credited_amount).toBe('250000000');
  });

  it('sums two transfers that together pay the amount', async () => {
    const created = await createPayment('SOL', '0.300000000');
    const payment = created.json<GatewayPayment>();
    const destination = payment.paymentDestination.address;

    await node.transferLamports(funder, destination, 100_000_000n);
    await settle(payment.id);
    const current = await readPaymentRow(payment.id);
    expect(current.status).toBe('partially_funded');

    await node.transferLamports(funder, destination, 200_000_000n);
    const row = await settle(payment.id);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('300000000');
    expect(await transfersFor(payment.id)).toHaveLength(2);
  });
});
