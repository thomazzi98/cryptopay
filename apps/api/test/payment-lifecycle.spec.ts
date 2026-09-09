import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { createPublicClient, createWalletClient, http, type Abi, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EvaluatePaymentsUseCase } from '../src/application/evaluate-payments.use-case.js';
import { ScanNetworkUseCase } from '../src/application/scan-network.use-case.js';
import type {
  ChainGateway,
  FinalityConfirmation,
} from '../src/application/ports/chain-gateway.port.js';
import { EvmChainGateway } from '../src/infrastructure/chain/evm-chain-gateway.js';
import { registerLocalDevelopmentAsset } from '../src/infrastructure/chain/network-configuration.js';
import { BlockCursorRepository } from '../src/infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from '../src/infrastructure/persistence/chain-scan.store.js';
import { EvaluationQueueRepository } from '../src/infrastructure/persistence/evaluation-queue.repository.js';
import { ObservedBlockRepository } from '../src/infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from '../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../src/infrastructure/persistence/payment-transfer.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { anvilAccount, mineBlock } from './setup/anvil.global-setup.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * A payment from creation to completion, driven only by what happens on the chain.
 *
 * This is the claim the whole system rests on: the backend decides, and the browser is never asked.
 * Nothing in this file tells the API that a payment was made. A transfer is broadcast, blocks are
 * mined, and the workers are ticked; everything else is the system's own conclusion.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const FENCING_TOKEN = 1n;
const REQUIRED_CONFIRMATIONS = 2;

const payer = anvilAccount(0);
const customer = anvilAccount(1);

let pool: Pool;
let dropDatabase: () => Promise<void>;
let rpcUrl: string;
let tokenAddress: string;
let tokenAbi: Abi;
let gateway: ChainGateway;
let scanner: ScanNetworkUseCase;
let payments: PaymentRepository;
let paymentCounter = 0;
let currentTime = new Date('2026-09-07T12:00:00.000Z');
let secondOpinionCalls = 0;

function publicClient() {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * A gateway that answers the finality question the way a chain publishing a finality tag would.
 * Anvil publishes none, so the tag is supplied here rather than pretending the local chain has one;
 * every other answer still comes from the real chain.
 */
function withFinalityTag(source: ChainGateway, lagBehindTip: bigint): ChainGateway {
  return {
    ...source,
    networkIdentifier: source.networkIdentifier,
    supportsFinalityTag: true,
    assertLedgerIdentity: () => source.assertLedgerIdentity(),
    readChainProgress: async () => {
      const progress = await source.readChainProgress();
      const finalized = progress.tip.height - lagBehindTip;
      return { ...progress, finalizedHeight: finalized < 0n ? null : finalized };
    },
    confirmFinalizedHeight: async (height: bigint): Promise<FinalityConfirmation> => {
      secondOpinionCalls += 1;
      const progress = await source.readChainProgress();
      return progress.tip.height - lagBehindTip >= height ? 'confirmed' : 'contradicted';
    },
    readPositionAtHeight: (height) => source.readPositionAtHeight(height),
    scanIncomingTransfers: (request) => source.scanIncomingTransfers(request),
    reconcileTransfer: (reference, expected) => source.reconcileTransfer(reference, expected),
    readAssetBalance: (account, asset) => source.readAssetBalance(account, asset),
    readNativeBalance: (account) => source.readNativeBalance(account),
  };
}

function evaluatorFor(source: ChainGateway, workerIdentity: string): EvaluatePaymentsUseCase {
  return new EvaluatePaymentsUseCase({
    gateway: source,
    paymentRepository: payments,
    paymentTransferRepository: new PaymentTransferRepository(pool),
    evaluationQueueRepository: new EvaluationQueueRepository(pool),
    now: () => currentTime,
    workerIdentity,
    ulidFactory: new UlidFactory(),
    checkoutBaseUrl: 'https://pay.cryptopay.test',
  });
}

async function payTo(destination: string, amount: bigint): Promise<void> {
  const wallet = createWalletClient({ account: customer, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: tokenAddress as Address,
    abi: tokenAbi,
    functionName: 'transfer',
    args: [destination as Address, amount],
    account: customer,
    chain: null,
  });
  await mineBlock(rpcUrl);
}

async function insertPayment(
  receivingAccount: string,
  options: {
    requested?: bigint;
    minimum?: bigint;
    maximum?: bigint;
    lifetimeMinutes?: number;
  } = {},
): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3D7${paymentCounter.toString().padStart(3, '0')}`;
  const requested = options.requested ?? 25_000_000n;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at
     ) VALUES ($1,$2,'test','local-anvil',$1,$3,'USDC',6,$4,$5,$6,$7,'pending',$8,true,0,
               $9::timestamptz + make_interval(mins => $10))`,
    [
      id,
      MERCHANT_ID,
      tokenAddress,
      requested.toString(),
      (options.minimum ?? requested).toString(),
      (options.maximum ?? requested).toString(),
      receivingAccount,
      REQUIRED_CONFIRMATIONS,
      currentTime.toISOString(),
      options.lifetimeMinutes ?? 30,
    ],
  );
  return id;
}

/** A live payment on a chain this test's worker does not watch. */
async function insertForeignNetworkPayment(): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3D8${paymentCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at
     ) VALUES ($1,$2,'test','polygon-amoy',$1,
               '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582','USDC',6,
               25000000,25000000,25000000,$3,'pending',5,true,0,
               $4::timestamptz + make_interval(mins => 30))`,
    [id, MERCHANT_ID, anvilAccount(43).address.toLowerCase(), currentTime.toISOString()],
  );
  return id;
}

/** A payment that expects the chain's own currency rather than a token. */
async function insertNativePayment(receivingAccount: string, requested: bigint): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3D9${paymentCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at
     ) VALUES ($1,$2,'test','local-anvil',$1,'native','ETH',18,$3,$3,$3,$4,'pending',$5,true,0,
               $6::timestamptz + make_interval(mins => 30))`,
    [
      id,
      MERCHANT_ID,
      requested.toString(),
      receivingAccount,
      REQUIRED_CONFIRMATIONS,
      currentTime.toISOString(),
    ],
  );
  return id;
}

/** A plain value transfer: no contract, no log, nothing for a log filter to find. */
async function sendNative(destination: string, amount: bigint): Promise<void> {
  const wallet = createWalletClient({ account: customer, transport: http(rpcUrl) });
  await wallet.sendTransaction({
    to: destination as Address,
    value: amount,
    account: customer,
    chain: null,
  });
  await mineBlock(rpcUrl);
}

async function placeCursorAtTip(): Promise<void> {
  const tip = await publicClient().getBlock({ blockTag: 'latest' });
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range,
        fencing_token)
     VALUES ('local-anvil', $1, $2, 100, $3)
     ON CONFLICT (network_identifier) DO UPDATE
       SET last_scanned_height = EXCLUDED.last_scanned_height,
           last_scanned_reference = EXCLUDED.last_scanned_reference,
           consecutive_successes = 0,
           halted_at = NULL,
           halted_reason = NULL`,
    [tip.number.toString(), tip.hash.toLowerCase(), FENCING_TOKEN.toString()],
  );
  await pool.query(`DELETE FROM observed_blocks WHERE network_identifier = 'local-anvil'`);
  await pool.query('DELETE FROM payment_evaluation_queue');

  // The sweep enqueues every live payment on the network, so a payment left confirming by an earlier
  // test would be evaluated by this one and counted against its request budget. Retiring them keeps
  // each test's live set to its own.
  await pool.query(
    `UPDATE payments SET status = 'canceled'
      WHERE network_identifier = 'local-anvil'
        AND status IN ('pending', 'partially_funded', 'confirming')`,
  );
}

async function readStatus(paymentId: string): Promise<string> {
  const result = await pool.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
    paymentId,
  ]);
  return result.rows[0]?.status ?? 'missing';
}

async function readPaymentRow(paymentId: string) {
  const result = await pool.query<{
    status: string;
    status_version: number;
    credited_amount: string;
    confirmations_observed: number;
    finality_confirmed: boolean;
    completed_at: Date | null;
    first_credited_at: Date | null;
  }>(
    `SELECT status, status_version, credited_amount, confirmations_observed, finality_confirmed,
            completed_at, first_credited_at
       FROM payments WHERE id = $1`,
    [paymentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No payment ${paymentId}`);
  }
  return row;
}

async function transitionsFor(paymentId: string): Promise<string[]> {
  const result = await pool.query<{ to_status: string }>(
    `SELECT to_status FROM payment_status_transitions WHERE payment_id = $1 ORDER BY to_version`,
    [paymentId],
  );
  return result.rows.map((row) => row.to_status);
}

/** One turn of the whole loop: observe the chain, then decide what it means. */
async function tick(evaluator: EvaluatePaymentsUseCase): Promise<void> {
  await scanner.execute(FENCING_TOKEN);
  await evaluator.execute();
}

beforeAll(async () => {
  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress');

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'lifecycle');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Lifecycle Fixtures')`, [
    MERCHANT_ID,
  ]);
  registerLocalDevelopmentAsset({ reference: tokenAddress, symbol: 'USDC', decimals: 6 });

  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: tokenAddress as Address,
    abi: tokenAbi,
    functionName: 'mint',
    args: [customer.address, 1_000_000_000_000n],
    account: payer,
    chain: null,
  });
  await mineBlock(rpcUrl);

  const chain = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });
  gateway = withFinalityTag(chain, 3n);

  payments = new PaymentRepository(pool);
  scanner = new ScanNetworkUseCase({
    gateway,
    paymentRepository: payments,
    paymentTransferRepository: new PaymentTransferRepository(pool),
    blockCursorRepository: new BlockCursorRepository(pool),
    observedBlockRepository: new ObservedBlockRepository(pool),
    chainScanStore: new ChainScanStore(pool),
    ulidFactory: new UlidFactory(),
    now: () => currentTime,
  });
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  currentTime = new Date('2026-09-07T12:00:00.000Z');
  secondOpinionCalls = 0;
  await placeCursorAtTip();
});

describe('a payment that is paid in full', () => {
  it('reaches completed without anything ever telling the API it was paid', async () => {
    const account = anvilAccount(30).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 25_000_000n);
    await tick(evaluator);
    expect(await readStatus(paymentId)).toBe('confirming');

    for (let mined = 0; mined < 6; mined += 1) {
      await mineBlock(rpcUrl);
      await tick(evaluator);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('25000000');
    expect(row.finality_confirmed).toBe(true);
    expect(row.completed_at).not.toBeNull();
    expect(row.first_credited_at).not.toBeNull();
  });

  it('leaves an audit trail of exactly the transitions it took', async () => {
    const account = anvilAccount(31).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 25_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    expect(await transitionsFor(paymentId)).toEqual(['confirming', 'completed']);
  });

  /**
   * Confirmations climb on nearly every tick. If each were an audit row, the timeline a merchant
   * reads would be hundreds of entries deep and the two that matter would be invisible.
   */
  it('does not write an audit row for every confirmation', async () => {
    const account = anvilAccount(32).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 25_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    const transitions = await transitionsFor(paymentId);
    const row = await readPaymentRow(paymentId);
    expect(transitions.length).toBeLessThanOrEqual(2);
    expect(row.status_version).toBe(2);
  });
});

describe('the finality gate', () => {
  /**
   * Enough confirmations is not enough. The window between the count being satisfied and the block
   * being finalized is exactly where a reorg lives, and a count-only gate pays the merchant inside
   * it.
   */
  it('holds a payment that has the confirmations but not the finality', async () => {
    const account = anvilAccount(33).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const laggingFinality = withFinalityTag(gateway, 40n);
    const evaluator = evaluatorFor(laggingFinality, 'worker-a');

    await payTo(account, 25_000_000n);
    for (let mined = 0; mined < 8; mined += 1) {
      await scanner.execute(FENCING_TOKEN);
      await evaluator.execute();
      await mineBlock(rpcUrl);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('confirming');
    expect(row.confirmations_observed).toBeGreaterThan(REQUIRED_CONFIRMATIONS);
  });

  /**
   * The quorum call costs a request, so it is spent only when a payment is otherwise ready to
   * complete. Asking on every tick would multiply the request budget by the polling rate for an
   * answer that cannot change the outcome.
   */
  it('asks a second provider only when a completion is otherwise eligible', async () => {
    const account = anvilAccount(34).address.toLowerCase();
    await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await tick(evaluator);
    await tick(evaluator);
    expect(secondOpinionCalls).toBe(0);

    await payTo(account, 25_000_000n);
    await tick(evaluator);
    expect(secondOpinionCalls).toBe(0);

    for (let mined = 0; mined < 6; mined += 1) {
      await mineBlock(rpcUrl);
      await tick(evaluator);
    }
    expect(secondOpinionCalls).toBeGreaterThan(0);
    expect(secondOpinionCalls).toBeLessThanOrEqual(4);
  });
});

describe('a payment that is not paid in full', () => {
  it('sits in partially_funded while the amount is short', async () => {
    const account = anvilAccount(35).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 10_000_000n);
    await tick(evaluator);

    expect(await readStatus(paymentId)).toBe('partially_funded');
  });

  it('completes once the remainder arrives, summing the transfers', async () => {
    const account = anvilAccount(36).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 10_000_000n);
    await tick(evaluator);
    await payTo(account, 15_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('25000000');
  });

  it('becomes underpaid rather than expired when the clock runs out with money in it', async () => {
    const account = anvilAccount(37).address.toLowerCase();
    const paymentId = await insertPayment(account, { lifetimeMinutes: 30 });
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 10_000_000n);
    await tick(evaluator);

    currentTime = new Date('2026-09-07T12:31:00.000Z');
    await evaluator.execute();

    expect(await readStatus(paymentId)).toBe('underpaid');
  });

  it('expires with nothing credited', async () => {
    const account = anvilAccount(38).address.toLowerCase();
    const paymentId = await insertPayment(account, { lifetimeMinutes: 30 });
    const evaluator = evaluatorFor(gateway, 'worker-a');

    currentTime = new Date('2026-09-07T12:31:00.000Z');
    await evaluator.execute();

    expect(await readStatus(paymentId)).toBe('expired');
  });

  /**
   * The race that decides whether a customer loses their money. Their transfer has already left
   * their wallet; expiring the payment on a timer that fired in the same second would be taking it.
   */
  it('never expires a payment that is already funded and confirming', async () => {
    const account = anvilAccount(39).address.toLowerCase();
    const paymentId = await insertPayment(account, { lifetimeMinutes: 30 });
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 25_000_000n);
    currentTime = new Date('2026-09-07T12:31:00.000Z');
    await tick(evaluator);

    expect(await readStatus(paymentId)).toBe('confirming');
  });
});

describe('overpayment', () => {
  it('is a separate outcome from a completion, never silently pocketed', async () => {
    const account = anvilAccount(40).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const evaluator = evaluatorFor(gateway, 'worker-a');

    await payTo(account, 40_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('overpaid');
    expect(row.credited_amount).toBe('40000000');
  });
});

describe('two workers evaluating the same payments', () => {
  /**
   * The compare-and-swap, not the lease, is what makes this safe. Both workers see the same payment
   * at the same version and exactly one write lands; the unique constraint on
   * (payment_id, to_version) is the backstop if the comparison were ever bypassed.
   */
  it('produces exactly one transition per payment', async () => {
    const account = anvilAccount(41).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payTo(account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    await Promise.all([
      evaluatorFor(gateway, 'worker-a').execute(),
      evaluatorFor(gateway, 'worker-b').execute(),
      evaluatorFor(gateway, 'worker-c').execute(),
    ]);

    const row = await readPaymentRow(paymentId);
    expect(await transitionsFor(paymentId)).toEqual(['confirming']);
    expect(row.status_version).toBe(1);
  });
});

describe('claiming work from the evaluation queue', () => {
  /**
   * A worker holds one gateway and judges everything it claims against that chain's tip. Claiming a
   * payment from another network would count its confirmations against a head that has nothing to
   * do with it, so the payment completes early or never completes at all.
   */
  it('leaves a payment on another network to the worker that watches it', async () => {
    const queue = new EvaluationQueueRepository(pool);
    const localPaymentId = await insertPayment(anvilAccount(42).address.toLowerCase());
    const foreignPaymentId = await insertForeignNetworkPayment();

    await queue.enqueue(localPaymentId);
    await queue.enqueue(foreignPaymentId);

    const localClaim = await queue.claim('worker-local', 'local-anvil', 10, 30);
    expect(localClaim).toEqual([localPaymentId]);

    const foreignClaim = await queue.claim('worker-amoy', 'polygon-amoy', 10, 30);
    expect(foreignClaim).toEqual([foreignPaymentId]);
  });
});

/**
 * Native currency, which is a different detection problem rather than a different asset.
 *
 * An ERC-20 transfer emits a Transfer event that a log filter finds cheaply. A plain value transfer
 * emits nothing at all, so the only way to see one is to read the block body and look at where the
 * value went. These drive that path against a real chain.
 */
describe('a payment made in the chain own currency', () => {
  it('detects a plain value transfer and completes the payment', async () => {
    const account = anvilAccount(50).address.toLowerCase();
    const paymentId = await insertNativePayment(account, 1_500_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await sendNative(account, 1_500_000_000_000_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('1500000000000000000');
    expect(await transitionsFor(paymentId)).toEqual(['confirming', 'completed']);
  });

  it('credits a partial native payment without completing it', async () => {
    const account = anvilAccount(51).address.toLowerCase();
    const paymentId = await insertNativePayment(account, 2_000_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await sendNative(account, 500_000_000_000_000_000n);
    await tick(evaluator);

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('partially_funded');
    expect(row.credited_amount).toBe('500000000000000000');
  });

  it('does not credit value sent to a different address', async () => {
    const account = anvilAccount(52).address.toLowerCase();
    const paymentId = await insertNativePayment(account, 1_000_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await sendNative(anvilAccount(53).address.toLowerCase(), 1_000_000_000_000_000_000n);
    await tick(evaluator);

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('pending');
    expect(row.credited_amount).toBe('0');
  });

  /**
   * A token payment must not be satisfied by native currency, nor the reverse. The asset reference
   * is the identity, and the native sentinel is not an address any token has.
   */
  it('does not let native currency satisfy a payment expecting a token', async () => {
    const account = anvilAccount(54).address.toLowerCase();
    const paymentId = await insertPayment(account, { requested: 25_000_000n });
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await sendNative(account, 5_000_000_000_000_000_000n);
    await tick(evaluator);

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('pending');
    expect(row.credited_amount).toBe('0');
  });

  it('does not let a token satisfy a payment expecting native currency', async () => {
    const account = anvilAccount(55).address.toLowerCase();
    const paymentId = await insertNativePayment(account, 1_000_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await payTo(account, 25_000_000n);
    await tick(evaluator);

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('pending');
    expect(row.credited_amount).toBe('0');
  });

  /**
   * A reverted transaction still occupies a block and still carries a value and a recipient, so a
   * scanner that trusted the block body alone would credit money that never moved. The receipt is
   * what distinguishes them, and before this test existed the receipt check could have been deleted
   * without a single assertion failing.
   *
   * The destination is the token contract, which has no payable fallback, so value sent to it
   * reverts on a real chain rather than being simulated.
   */
  it('does not credit a value transfer whose transaction reverted', async () => {
    const paymentId = await insertNativePayment(tokenAddress.toLowerCase(), 1_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    const wallet = createWalletClient({ account: customer, transport: http(rpcUrl) });
    // Anvil may refuse it at estimation or mine it as a failure. Either outcome must leave the
    // payment uncredited, and the assertion below covers both without branching on which happened.
    let reverted: `0x${string}` | null;
    try {
      reverted = await wallet.sendTransaction({
        to: tokenAddress as Address,
        value: 1_000_000_000_000_000n,
        account: customer,
        chain: null,
        gas: 200_000n,
      });
    } catch {
      reverted = null;
    }
    await mineBlock(rpcUrl);

    const receipt =
      reverted === null ? null : await publicClient().getTransactionReceipt({ hash: reverted });
    expect(receipt?.status ?? 'rejected before it was mined').not.toBe('success');

    await tick(evaluator);
    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('pending');
    expect(row.credited_amount).toBe('0');
  });

  it('sums two native transfers to the same destination', async () => {
    const account = anvilAccount(56).address.toLowerCase();
    const paymentId = await insertNativePayment(account, 2_000_000_000_000_000_000n);
    const evaluator = evaluatorFor(gateway, 'worker-native');

    await sendNative(account, 1_200_000_000_000_000_000n);
    await sendNative(account, 800_000_000_000_000_000n);
    for (let mined = 0; mined < 7; mined += 1) {
      await tick(evaluator);
      await mineBlock(rpcUrl);
    }

    const row = await readPaymentRow(paymentId);
    expect(row.status).toBe('completed');
    expect(row.credited_amount).toBe('2000000000000000000');
  });
});
