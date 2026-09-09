import {
  buildPaymentUri,
  CheckoutSchema,
  type Checkout,
  type NetworkFamily,
  type PaymentContract,
} from '@cryptopay/shared';
import type { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EvaluatePaymentsUseCase } from '../../src/application/evaluate-payments.use-case.js';
import { ReconcilePaymentsUseCase } from '../../src/application/reconcile-payments.use-case.js';
import { ScanNetworkUseCase } from '../../src/application/scan-network.use-case.js';
import { buildApplicationServer } from '../../src/composition-root.js';
import { loadConfiguration } from '../../src/configuration.js';
import type { ApplicationServer } from '../../src/http/server-types.js';
import { registerLocalDevelopmentAsset } from '../../src/infrastructure/chain/network-configuration.js';
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
import { renderPaymentQrCode } from '../../src/infrastructure/qr/qr-code.js';
import { decodeQrCode } from '../../src/infrastructure/qr/qr-decoder.test-helper.js';
import { UlidFactory } from '../../src/infrastructure/system/ulid.js';
import { createLocalKeyWrapper } from '../../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../../src/infrastructure/wallet/master-seed.js';
import {
  connectionUrlFor,
  createIsolatedDatabase,
} from '../../test/setup/postgres.global-setup.js';
import { SolanaTestNode, type SolanaKeypair } from '../setup/solana-node.js';
import { associatedTokenAccount, randomKeypair } from '../setup/solana-transactions.js';

/**
 * A Solana payment from creation to completion, in SOL and in an SPL token, against a real
 * validator.
 *
 * The chain is a local single-node `agave-test-validator`, not devnet, and the difference is stated
 * rather than glossed: one node reaches its own consensus with nobody to disagree, so nothing here
 * exercises a skipped slot, a fork, or a public endpoint's rate limit. Everything else is real. The
 * validator deserialises the transactions, verifies the ed25519 signatures, runs the SPL Token
 * program and finalises the slots, and answers over the same JSON-RPC surface the adapter uses in
 * production. Nothing in this file tells the API a payment was made.
 *
 * The SPL half is the case the adapter is designed around. An SPL transfer credits a token account,
 * not the wallet, so matching on the wallet address alone would miss every token payment. The
 * adapter reads the owner the node itself resolved rather than deriving an associated address, and
 * this suite pays into a real associated account to prove it.
 *
 * Skipped when no validator answers. `npm run test:solana-local` after
 * `docker run -d -p 8899:8899 --name cryptopay-solana anzaxyz/agave:v2.1.14 agave-test-validator`.
 */

const PEPPER = 's'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 17);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3S1001';
const NETWORK = 'solana-local';
const FENCING_TOKEN = 1n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const TOKEN_SYMBOL = 'USDC';
const TOKEN_DECIMALS = 6;
const CALLBACK_URL = 'https://merchant.example.com/hooks/cryptopay';

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
let mint = '';
let funderTokenAccount = '';
let testKey = '';
let currentTime = new Date('2026-09-07T12:00:00.000Z');

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let referenceCounter = 0;

/**
 * Created through the network-identifier endpoint rather than the gateway one, because the gateway
 * takes a family and resolves it to the deployment the key is allowed to reach. It refuses to hand
 * anybody a local development chain, which is the behaviour a real caller needs and the reason this
 * suite names the network directly.
 */
async function createPayment(assetSymbol: string, amount: string): Promise<PaymentContract> {
  referenceCounter += 1;
  const response = await server.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: {
      authorization: `Bearer ${testKey}`,
      'content-type': 'application/json',
      'idempotency-key': `solana-local-${referenceCounter.toString()}`,
    },
    payload: {
      network: NETWORK,
      assetSymbol,
      amount,
      merchantReference: `order_${referenceCounter.toString()}`,
      expiresInSeconds: 1800,
      callbackUrl: CALLBACK_URL,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `Creating a payment answered ${response.statusCode.toString()}: ${response.body}`,
    );
  }
  return response.json<PaymentContract>();
}

interface CustomerView {
  readonly checkout: Checkout;
  readonly paymentUri: string;
  readonly scannedBack: string | null;
}

/**
 * What a customer is actually shown, read back over HTTP and built with the one authoritative
 * builder, exactly as the hosted checkout does it. A URI the test composed itself would prove only
 * that the test agrees with itself.
 */
async function customerView(paymentId: string): Promise<CustomerView> {
  const token = await pool.query<{ checkout_token: string }>(
    'SELECT checkout_token FROM payments WHERE id = $1',
    [paymentId],
  );
  const viewed = await server.inject({
    method: 'GET',
    url: `/v1/checkout/${token.rows[0]?.checkout_token ?? ''}`,
  });
  const parsed = CheckoutSchema.safeParse(viewed.json());
  if (!parsed.success) {
    throw new Error(`The checkout did not match the published contract: ${parsed.error.message}`);
  }
  const checkout = parsed.data;
  const paymentUri = buildPaymentUri({
    networkFamily: checkout.networkFamily as NetworkFamily,
    evmChainId: checkout.chainIdentifier,
    destinationAccount: checkout.receivingAccount,
    assetReference: checkout.asset.reference,
    assetDecimals: checkout.asset.decimals,
    amountInBaseUnits: checkout.requestedAmount.baseUnits,
    memo: null,
  });
  return {
    checkout,
    paymentUri,
    scannedBack: decodeQrCode(renderPaymentQrCode(paymentUri).bytes),
  };
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

async function publishedEventsFor(paymentId: string): Promise<string[]> {
  const result = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM webhook_deliveries WHERE payment_id = $1 ORDER BY id`,
    [paymentId],
  );
  return result.rows.map((row) => row.event_type);
}

/**
 * Scanning reads finalized slots only, so a transfer is invisible until finalisation reaches the
 * slot that carried it. Ticking until the payment moves is the honest wait; a fixed sleep would be
 * either flaky or slower than it needs to be.
 */
async function settle(paymentId: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
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
  await node.awaitFinalized(await node.airdrop(funder.account, 100n * LAMPORTS_PER_SOL));

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
    node: new HttpSolanaNode({ endpoint: node.url, timeoutMilliseconds: 60_000 }),
    // A local validator has its own genesis, and the adapter refuses to scan a chain that is not the
    // one it was configured for. Reading it rather than hardcoding it keeps that guard real.
    expectedLedgerIdentity: await node.genesisIdentity(),
  });

  // A real SPL mint with real decimals, created on the validator rather than assumed.
  mint = await node.createMint(funder, TOKEN_DECIMALS);
  funderTokenAccount = await node.createTokenAccount(funder, funder.account, mint);
  await node.mintTo(funder, mint, funderTokenAccount, 1_000_000_000_000n);
  registerLocalDevelopmentAsset(NETWORK, {
    reference: mint,
    symbol: TOKEN_SYMBOL,
    decimals: TOKEN_DECIMALS,
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
}, 300_000);

afterAll(async () => {
  // Defensive rather than tidy: when setup throws part way, an unguarded teardown reports its own
  // TypeError and hides the failure that actually mattered.
  await server?.close();
  await dropDatabase?.();
});

beforeEach(async () => {
  if (!nodeIsRunning) {
    return;
  }
  currentTime = new Date('2026-09-07T12:00:00.000Z');
  await placeCursorAtFinalizedHead();
});

describe.skipIf(!nodeIsRunning)('a SOL payment nobody told the API about', () => {
  it('is created with a destination the validator itself accepts, and a URI that scans', async () => {
    const payment = await createPayment('SOL', '0.500000000');
    const view = await customerView(payment.identifier);

    expect(payment.chainIdentifier).toBeNull();
    expect(view.paymentUri).toBe(`solana:${payment.receivingAccount}?amount=0.5`);
    expect(view.scannedBack).toBe(view.paymentUri);
    await expect(node.balance(payment.receivingAccount)).resolves.toBe(0n);
  });

  it('reaches completed from a real transfer, and records what paid it', async () => {
    const payment = await createPayment('SOL', '0.500000000');

    const signature = await node.transferLamports(
      funder,
      payment.receivingAccount,
      LAMPORTS_PER_SOL / 2n,
    );
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('500000000');
    expect(row.finality_confirmed).toBe(true);

    const [transfer] = await transfersFor(payment.identifier);
    expect(transfer?.transaction_reference).toBe(signature);
    expect(transfer?.amount).toBe('500000000');
    expect(transfer?.asset_reference).toBe('native');
    expect(transfer?.classification).toBe('credited');
  });

  it('leaves an audit trail of exactly the transitions it took', async () => {
    const payment = await createPayment('SOL', '0.250000000');

    await node.transferLamports(funder, payment.receivingAccount, 250_000_000n);
    await settle(payment.identifier);

    expect(await transitionsFor(payment.identifier)).toEqual(['confirming', 'completed']);
  });

  it('publishes the completion for the merchant to be told about', async () => {
    const payment = await createPayment('SOL', '0.100000000');

    await node.transferLamports(funder, payment.receivingAccount, 100_000_000n);
    await settle(payment.identifier);

    expect(await publishedEventsFor(payment.identifier)).toContain('payment.completed');
  });
});

/**
 * The token half. An SPL transfer credits a token account rather than the wallet, so the adapter
 * matches on the owner the node resolved rather than deriving an associated address itself. This
 * pays into a real associated account created in the same transaction, which is what a wallet does.
 */
describe.skipIf(!nodeIsRunning)('an SPL payment nobody told the API about', () => {
  it('creates a mint with the decimals it was asked for', async () => {
    expect(mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    await expect(node.tokenBalance(funderTokenAccount)).resolves.toBe(1_000_000_000_000n);
  });

  it('is created against the mint, with a Solana Pay URI naming it', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '25.000000');
    const view = await customerView(payment.identifier);

    expect(payment.asset.reference).toBe(mint);
    expect(payment.asset.decimals).toBe(TOKEN_DECIMALS);
    // Solana Pay carries a decimal figure in whole tokens, not base units. Sending base units here
    // would ask a wallet for a million times the intended amount.
    expect(view.paymentUri).toBe(`solana:${payment.receivingAccount}?amount=25&spl-token=${mint}`);
    expect(view.scannedBack).toBe(view.paymentUri);
    expect(view.scannedBack).toContain(mint);
    expect(view.scannedBack).not.toContain(mint.toLowerCase());
  });

  it('reaches completed from a real token transfer, and records what paid it', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '25.000000');

    const signature = await node.transferToken(
      funder,
      funderTokenAccount,
      payment.receivingAccount,
      mint,
      25_000_000n,
    );
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('25000000');
    expect(row.finality_confirmed).toBe(true);

    const [transfer] = await transfersFor(payment.identifier);
    expect(transfer?.transaction_reference).toBe(signature);
    expect(transfer?.amount).toBe('25000000');
    expect(transfer?.asset_reference).toBe(mint);
    expect(transfer?.classification).toBe('credited');
  });

  /**
   * The property the adapter is built on, asserted rather than assumed: the tokens landed in a
   * derived associated account, and the payment was still attributed to the wallet that owns it.
   */
  it('credits the wallet that owns the token account, not the token account', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '8.000000');

    await node.transferToken(
      funder,
      funderTokenAccount,
      payment.receivingAccount,
      mint,
      8_000_000n,
    );
    await settle(payment.identifier);

    const derived = associatedTokenAccount(payment.receivingAccount, mint);
    expect(derived).not.toBe(payment.receivingAccount);
    await expect(node.tokenBalance(derived)).resolves.toBe(8_000_000n);
    // The wallet itself holds no lamports and no token account of its own, and was still paid.
    const credited = await readPaymentRow(payment.identifier);
    expect(credited.credited_amount).toBe('8000000');
  });

  it('transitions, publishes and reads back as completed', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '10.000000');

    await node.transferToken(
      funder,
      funderTokenAccount,
      payment.receivingAccount,
      mint,
      10_000_000n,
    );
    await settle(payment.identifier);

    expect(await transitionsFor(payment.identifier)).toEqual(['confirming', 'completed']);
    expect(await publishedEventsFor(payment.identifier)).toContain('payment.completed');

    const viewed = await server.inject({
      method: 'GET',
      url: `/v1/payments/${payment.identifier}`,
      headers: { authorization: `Bearer ${testKey}` },
    });
    const settled = viewed.json<PaymentContract>();
    expect(settled.status).toBe('completed');
    expect(settled.creditedAmount.display).toBe('10.000000');
  });

  it('does not credit a token transfer to somebody else', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '6.000000');
    const stranger = randomKeypair();

    await node.transferToken(funder, funderTokenAccount, stranger.account, mint, 6_000_000n);
    await tick();
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.identifier)).toHaveLength(0);
  });

  /**
   * The trap the token registry exists to prevent, on a real chain: the right amount, to the right
   * wallet, in the wrong asset must not settle the payment.
   */
  it('does not credit native SOL against a token payment', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '7.000000');

    await node.transferLamports(funder, payment.receivingAccount, 7_000_000n);
    await tick();
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.credited_amount).toBe('0');
    expect(current.status).toBe('pending');
  });
});

describe.skipIf(!nodeIsRunning)('what the validator says that the payment did not ask for', () => {
  it('does not credit a transfer to somebody else', async () => {
    const payment = await createPayment('SOL', '0.300000000');
    const stranger = randomKeypair();

    await node.transferLamports(funder, stranger.account, 300_000_000n);
    await tick();
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.identifier)).toHaveLength(0);
  });

  it('reports an underpayment rather than completing it', async () => {
    const payment = await createPayment('SOL', '0.400000000');

    await node.transferLamports(funder, payment.receivingAccount, 300_000_000n);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('partially_funded');
    expect(row.credited_amount).toBe('300000000');
  });

  it('completes an overpayment and records the whole amount received', async () => {
    const payment = await createPayment('SOL', '0.100000000');

    await node.transferLamports(funder, payment.receivingAccount, 250_000_000n);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('overpaid');
    expect(row.credited_amount).toBe('250000000');
  });

  it('sums two transfers that together pay the amount', async () => {
    const payment = await createPayment('SOL', '0.300000000');

    await node.transferLamports(funder, payment.receivingAccount, 100_000_000n);
    await settle(payment.identifier);
    const partial = await readPaymentRow(payment.identifier);
    expect(partial.status).toBe('partially_funded');

    await node.transferLamports(funder, payment.receivingAccount, 200_000_000n);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('300000000');
    expect(await transfersFor(payment.identifier)).toHaveLength(2);
  });
});

/**
 * The safety net, against a real chain rather than a stub: a transfer the scanner never saw is still
 * found, because reconciliation compares this system's belief against balances the chain reports
 * rather than against its own records.
 */
describe.skipIf(!nodeIsRunning)('a payment the scanner missed entirely', () => {
  it('is discovered by reconciliation comparing balances against the chain', async () => {
    const payment = await createPayment('SOL', '0.350000000');
    await tick();

    await node.transferLamports(funder, payment.receivingAccount, 350_000_000n);
    // Paid while the scanner is not looking: the cursor is moved past the slot that carries it,
    // which is what a halted or lagging worker leaves behind.
    const progress = await gateway.readChainProgress();
    await pool.query(
      `UPDATE block_cursors SET last_scanned_height = $2 WHERE network_identifier = $1`,
      [NETWORK, (progress.finalizedHeight ?? progress.tip.height).toString()],
    );
    await tick();

    const missed = await readPaymentRow(payment.identifier);
    expect(missed.credited_amount).toBe('0');

    const reconciler = new ReconcilePaymentsUseCase({
      gateway,
      paymentRepository: payments,
      paymentTransferRepository: new PaymentTransferRepository(pool),
      evaluationQueueRepository: new EvaluationQueueRepository(pool),
      now: () => currentTime,
    });
    const outcome = await reconciler.execute();

    expect(outcome.discrepancies).toBeGreaterThan(0);
  });
});
