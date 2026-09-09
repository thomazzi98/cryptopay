import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { TronChainGateway } from '../../src/infrastructure/chain/tron/tron-chain-gateway.js';
import { HttpTronNode } from '../../src/infrastructure/chain/tron/tron-client.js';
import { generateApiKey } from '../../src/infrastructure/crypto/api-key.js';
import { BlockCursorRepository } from '../../src/infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from '../../src/infrastructure/persistence/chain-scan.store.js';
import { EvaluationQueueRepository } from '../../src/infrastructure/persistence/evaluation-queue.repository.js';
import { ObservedBlockRepository } from '../../src/infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from '../../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../../src/infrastructure/persistence/payment-transfer.repository.js';
import { WalletSeedRepository } from '../../src/infrastructure/persistence/wallet-seed.repository.js';
import { scanPaymentQrCode } from '../../src/infrastructure/qr/qr-decoder.test-helper.js';
import { UlidFactory } from '../../src/infrastructure/system/ulid.js';
import { createLocalKeyWrapper } from '../../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../../src/infrastructure/wallet/master-seed.js';
import {
  connectionUrlFor,
  createIsolatedDatabase,
} from '../../test/setup/postgres.global-setup.js';
import {
  accountFor,
  decodeTronAddressPayload,
  deployContract,
  genesisAccount,
  isNodeRunning,
  readGenesisIdentity,
  readHeadHeight,
  sendTrx,
  triggerContract,
  TRON_NODE_BASE_URL,
  type FundedAccount,
} from '../setup/tron-node.js';

/**
 * A TRON payment from creation to completion, in TRX and in a TRC-20 token, against a real node.
 *
 * The chain is a local single-witness java-tron, not the public network, and the difference is
 * stated rather than glossed: no peers, so nothing here exercises reorganisation, propagation or how
 * TronGrid behaves under rate limiting. Everything else is real. The node encodes and validates the
 * transactions, checks the signatures, runs the contract, produces the blocks and answers over the
 * same TronGrid-compatible HTTP surface the adapter uses in production. Nothing in this file tells
 * the API a payment was made: a transfer is broadcast and the workers are ticked.
 *
 * The token half is the one that matters most on TRON. Event logs carry the contract on
 * `log.address` as twenty bare bytes and the parties in `log.topics` left-padded to thirty-two, none
 * of them carrying the `0x41` byte that makes them TRON addresses. Reading any of them as an EVM
 * address produces a plausible identity belonging to nobody, and a payment matched against it is
 * never credited.
 *
 * Skipped when no node answers. `npm run test:tron-local` after
 * `docker run -d -p 9090:9090 --name cryptopay-tre tronbox/tre`.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PEPPER = 't'.repeat(48);
const WALLET_KEY = Buffer.alloc(32, 13);
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3T1001';
const NETWORK = 'tron-local';
const FENCING_TOKEN = 1n;
/** What `tron-local` policy demands. Each one costs a real broadcast and a real block. */
const REQUIRED_CONFIRMATIONS = 2;
const SUN_PER_TRX = 1_000_000n;
const TOKEN_SYMBOL = 'USDT';
const TOKEN_DECIMALS = 6;

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
let tokenAccount = '';
let testKey = '';
let currentTime = new Date('2026-09-07T12:00:00.000Z');

const ulidFactory = new UlidFactory();
let keyCounter = 1_757_183_400_000;
let referenceCounter = 0;

/**
 * The node produces a block only when there is a transaction to put in it, and does not answer a
 * broadcast until that block exists, which makes confirmation counting exact rather than a race
 * against a timer. A one-sun transfer is therefore how this suite advances the chain, and it goes to
 * a ballast account rather than back to the sender because TRON rejects a transfer to yourself.
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
      'idempotency-key': `tron-local-${referenceCounter.toString()}`,
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
    // Scanned through the helper that tries several module sizes rather than one. The decoder
    // occasionally mis-samples a valid symbol at a single scale, and every payment here carries a
    // randomly derived destination, so a single-scale assertion fails for one run in a handful for a
    // reason that has nothing to do with this system.
    scannedBack: scanPaymentQrCode(paymentUri),
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
    completed_at: Date | null;
  }>(
    `SELECT status, credited_amount, confirmations_observed, completed_at
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

/** Drives one payment to completion, so each scenario reads as one story. */
async function settle(paymentId: string) {
  await tick();
  await mineBlocks(REQUIRED_CONFIRMATIONS + 1);
  await tick();
  return readPaymentRow(paymentId);
}

/** ABI encoding for `(address, uint256)`: a TRON address travels as its twenty-byte key hash. */
function addressAndAmount(account: string, amount: bigint): string {
  const keyHash = decodeTronAddressPayload(account).slice(2);
  return keyHash.padStart(64, '0') + amount.toString(16).padStart(64, '0');
}

async function sendToken(toAccount: string, amount: bigint): Promise<string> {
  return triggerContract(
    genesis,
    tokenAccount,
    'transfer(address,uint256)',
    addressAndAmount(toAccount, amount),
  );
}

/** Rewinds the cursor without cancelling live payments, so a replay can be observed. */
async function rewindCursor(): Promise<void> {
  const height = await readHeadHeight();
  await pool.query(
    `UPDATE block_cursors
        SET last_scanned_height = GREATEST($2::bigint - 30, 0), consecutive_successes = 0
      WHERE network_identifier = $1`,
    [NETWORK, height.toString()],
  );
  await pool.query('DELETE FROM observed_blocks WHERE network_identifier = $1', [NETWORK]);
}

async function placeCursorAtTip(): Promise<void> {
  const height = await readHeadHeight();
  const found = await gateway.readPositionAtHeight(BigInt(height));
  const reference = found.kind === 'found' ? found.position.reference : '';
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
      timeoutMilliseconds: 120_000,
    }),
    // The local chain has its own genesis, and the adapter refuses to scan a chain that is not the
    // one it was configured for. Reading it rather than hardcoding it is what keeps that guard real.
    expectedLedgerIdentity: await readGenesisIdentity(),
  });

  // The same ERC-20 artifact the Anvil suite deploys. TRON's virtual machine is EVM compatible, so
  // the bytecode is portable, and one artifact for both chains means the contract is not a variable
  // when the two adapters disagree.
  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: readonly unknown[]; bytecode: string };
  tokenAccount = await deployContract(genesis, artifact.bytecode, artifact.abi);
  registerLocalDevelopmentAsset(NETWORK, {
    reference: tokenAccount,
    symbol: TOKEN_SYMBOL,
    decimals: TOKEN_DECIMALS,
  });
  await triggerContract(
    genesis,
    tokenAccount,
    'mint(address,uint256)',
    addressAndAmount(genesis.account, 1_000_000_000_000n),
  );

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
  await placeCursorAtTip();
});

describe.skipIf(!nodeIsRunning)('a TRX payment nobody told the API about', () => {
  it('is created with a destination the chain itself accepts, and a URI that scans', async () => {
    const payment = await createPayment('TRX', '5.000000');
    const view = await customerView(payment.identifier);

    expect(payment.receivingAccount).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(view.paymentUri).toBe(`tron:${payment.receivingAccount}?amount=5000000`);
    expect(view.scannedBack).toBe(view.paymentUri);
    // The chain's own answer about the address, which is the only opinion that matters.
    await expect(gateway.readNativeBalance(payment.receivingAccount)).resolves.toBe(0n);
  });

  it('reaches completed from a real transfer, and records what paid it', async () => {
    const payment = await createPayment('TRX', '5.000000');

    const transactionId = await sendTrx(genesis, payment.receivingAccount, 5n * SUN_PER_TRX);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('5000000');
    expect(row.completed_at).not.toBeNull();

    const [transfer] = await transfersFor(payment.identifier);
    expect(transfer?.transaction_reference).toBe(transactionId);
    expect(transfer?.amount).toBe('5000000');
    expect(transfer?.source_account).toBe(genesis.account);
    expect(transfer?.asset_reference).toBe('native');
    expect(transfer?.classification).toBe('credited');
  });

  it('leaves an audit trail of exactly the transitions it took', async () => {
    const payment = await createPayment('TRX', '2.000000');

    await sendTrx(genesis, payment.receivingAccount, 2n * SUN_PER_TRX);
    await settle(payment.identifier);

    expect(await transitionsFor(payment.identifier)).toEqual(['confirming', 'completed']);
  });

  it('publishes the completion for the merchant to be told about', async () => {
    const payment = await createPayment('TRX', '3.000000');

    await sendTrx(genesis, payment.receivingAccount, 3n * SUN_PER_TRX);
    await settle(payment.identifier);

    expect(await publishedEventsFor(payment.identifier)).toContain('payment.completed');
  });
});

/**
 * The token half, which is the whole point of the local chain: the asset allowlist is frozen per
 * network and correctly refuses a contract deployed at runtime, so before `tron-local` existed a
 * TRC-20 payment could not be created at all and the coverage stopped at the adapter.
 */
describe.skipIf(!nodeIsRunning)('a TRC-20 payment nobody told the API about', () => {
  it('deploys a contract at an address in TRON form', () => {
    expect(tokenAccount).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('is created against the token, with a URI naming the contract', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '25.000000');
    const view = await customerView(payment.identifier);

    expect(payment.asset.reference).toBe(tokenAccount);
    expect(payment.asset.decimals).toBe(TOKEN_DECIMALS);
    expect(view.paymentUri).toBe(
      `tron:${payment.receivingAccount}?contractAddress=${tokenAccount}&amount=25000000`,
    );
    expect(view.scannedBack).toBe(view.paymentUri);
    // Case matters in base58, and the QR is where a lowercased address would become unrecoverable.
    expect(view.scannedBack).toContain(tokenAccount);
    expect(view.scannedBack).not.toContain(tokenAccount.toLowerCase());
  });

  it('reaches completed from a real token transfer, and records what paid it', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '25.000000');

    const transactionId = await sendToken(payment.receivingAccount, 25_000_000n);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('25000000');
    expect(row.confirmations_observed).toBeGreaterThanOrEqual(REQUIRED_CONFIRMATIONS);

    const [transfer] = await transfersFor(payment.identifier);
    expect(transfer?.transaction_reference).toBe(transactionId);
    expect(transfer?.amount).toBe('25000000');
    expect(transfer?.classification).toBe('credited');
    // Each of these came out of a log that carried no 0x41 byte. Reading them as EVM addresses
    // produces plausible identities belonging to nobody.
    expect(transfer?.asset_reference).toBe(tokenAccount);
    expect(transfer?.source_account).toBe(genesis.account);
  });

  it('transitions, publishes and reads back as completed', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '10.000000');

    await sendToken(payment.receivingAccount, 10_000_000n);
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

  it('reads the token balance the contract itself reports', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '4.000000');

    await sendToken(payment.receivingAccount, 4_000_000n);

    await expect(gateway.readAssetBalance(payment.receivingAccount, tokenAccount)).resolves.toBe(
      4_000_000n,
    );
  });

  it('does not credit a token transfer to somebody else', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '6.000000');
    const stranger = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 60));

    await sendToken(stranger, 6_000_000n);
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.identifier)).toHaveLength(0);
  });

  /**
   * The trap the token registry exists to prevent, exercised on a real chain: the right amount, to
   * the right address, in the wrong asset must not settle the payment.
   */
  it('does not credit the native currency against a token payment', async () => {
    const payment = await createPayment(TOKEN_SYMBOL, '7.000000');

    await sendTrx(genesis, payment.receivingAccount, 7n * SUN_PER_TRX);
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.credited_amount).toBe('0');
    expect(current.status).toBe('pending');
  });
});

describe.skipIf(!nodeIsRunning)('what the chain says that the payment did not ask for', () => {
  it('does not credit a transfer to somebody else', async () => {
    const payment = await createPayment('TRX', '4.000000');
    const stranger = accountFor(Uint8Array.from({ length: 32 }, (_unused, index) => index + 1));

    await sendTrx(genesis, stranger, 4n * SUN_PER_TRX);
    await tick();

    const current = await readPaymentRow(payment.identifier);
    expect(current.status).toBe('pending');
    expect(await transfersFor(payment.identifier)).toHaveLength(0);
  });

  /**
   * No confirmations are produced here. An underpaid payment stays partially funded however long the
   * chain runs, so mining to prove it would cost real blocks to assert nothing.
   */
  it('reports an underpayment rather than completing it', async () => {
    const payment = await createPayment('TRX', '6.000000');

    await sendTrx(genesis, payment.receivingAccount, 5n * SUN_PER_TRX);
    await tick();

    const row = await readPaymentRow(payment.identifier);
    expect(row.status).toBe('partially_funded');
    expect(row.credited_amount).toBe('5000000');
  });

  it('completes an overpayment and records the whole amount received', async () => {
    const payment = await createPayment('TRX', '2.000000');

    await sendTrx(genesis, payment.receivingAccount, 3n * SUN_PER_TRX);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('overpaid');
    expect(row.credited_amount).toBe('3000000');
  });

  it('sums two transfers that together pay the amount', async () => {
    const payment = await createPayment('TRX', '4.000000');

    await sendTrx(genesis, payment.receivingAccount, 1n * SUN_PER_TRX);
    await tick();
    const partial = await readPaymentRow(payment.identifier);
    expect(partial.status).toBe('partially_funded');

    await sendTrx(genesis, payment.receivingAccount, 3n * SUN_PER_TRX);
    const row = await settle(payment.identifier);

    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('4000000');
    expect(await transfersFor(payment.identifier)).toHaveLength(2);
  });

  /**
   * The scan window is replayed on every crash, so a transfer being seen twice is the normal case
   * rather than the exceptional one. Crediting it twice would double the merchant's money.
   */
  it('credits one transfer once, however many times it is scanned', async () => {
    const payment = await createPayment('TRX', '2.500000');

    await sendTrx(genesis, payment.receivingAccount, 2_500_000n);
    await tick();
    const creditedOnce = await readPaymentRow(payment.identifier);

    await rewindCursor();
    await tick();
    await tick();

    const afterReplay = await readPaymentRow(payment.identifier);
    expect(afterReplay.credited_amount).toBe(creditedOnce.credited_amount);
    expect(await transfersFor(payment.identifier)).toHaveLength(1);
  });
});

/**
 * The safety net, exercised against a real chain rather than a stub: a transfer the scanner never
 * saw is still found, because reconciliation compares this system's belief against balances the
 * chain reports rather than against its own records.
 */
describe.skipIf(!nodeIsRunning)('a payment the scanner missed entirely', () => {
  it('is discovered by reconciliation comparing balances against the chain', async () => {
    const payment = await createPayment('TRX', '3.500000');
    await tick();

    // Paid while the scanner is not looking: the cursor is moved past the block that carries it,
    // which is what a halted or lagging worker leaves behind.
    await sendTrx(genesis, payment.receivingAccount, 3_500_000n);
    await mineBlocks(1);
    const head = await readHeadHeight();
    await pool.query(
      `UPDATE block_cursors SET last_scanned_height = $2 WHERE network_identifier = $1`,
      [NETWORK, head.toString()],
    );
    await tick();

    const missed = await readPaymentRow(payment.identifier);
    expect(missed.status).toBe('pending');
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
