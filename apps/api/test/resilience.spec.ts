import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool, QueryResult } from 'pg';
import { createWalletClient, http, type Abi, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EvaluatePaymentsUseCase } from '../src/application/evaluate-payments.use-case.js';
import { ScanNetworkUseCase } from '../src/application/scan-network.use-case.js';
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
 * What survives a process dying at the worst possible moment.
 *
 * The database is failed deliberately at every query the scanner and the evaluator make, one index
 * at a time, and after each failure two invariants are checked. Both are about money, and both are
 * supposed to be UNREACHABLE rather than merely rare: a state that can be reached one time in a
 * thousand is a state that happens daily at volume.
 *
 *   A. A transfer is never recorded above the cursor that covers it. If it were, a restart would
 *      resume past the block holding it and that money would never be evaluated again.
 *   B. A payment that moved status and has a callback URL always has the delivery row for that
 *      status. If it did not, the merchant would never be told and there would be nothing left to
 *      retry.
 *
 * The point of injecting the fault at every index rather than at a chosen one is that a checkpoint
 * someone picked by hand is a checkpoint chosen to pass.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3G1001';
const FENCING_TOKEN = 1n;
const CALLBACK_URL = 'https://hooks.merchant.example/cryptopay';

const payer = anvilAccount(0);
const customer = anvilAccount(1);

let pool: Pool;
let dropDatabase: () => Promise<void>;
let rpcUrl: string;
let tokenAddress: string;
let tokenAbi: Abi;
let paymentCounter = 0;
const currentTime = new Date('2026-09-07T12:00:00.000Z');

class InjectedFailure extends Error {
  constructor(index: number) {
    super(`Injected database failure at query ${index.toString()}`);
    this.name = 'InjectedFailure';
  }
}

/**
 * A pool that fails on the nth query and counts how many it saw.
 *
 * Wrapping the pool rather than the repositories is deliberate: a fault injected at the repository
 * boundary can only fail where someone thought to allow it, and the interesting failures are the
 * ones between two statements inside a transaction.
 */
function failingPoolAt(
  source: Pool,
  failAtIndex: number,
): { pool: Pool; queriesSeen: () => number } {
  let seen = 0;

  const proxy = new Proxy(source, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (...parameters: unknown[]): Promise<QueryResult> => {
          seen += 1;
          if (seen === failAtIndex) {
            throw new InjectedFailure(failAtIndex);
          }
          return (target.query as (...args: unknown[]) => Promise<QueryResult>)(...parameters);
        };
      }
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === 'query') {
                return async (...parameters: unknown[]): Promise<QueryResult> => {
                  seen += 1;
                  if (seen === failAtIndex) {
                    throw new InjectedFailure(failAtIndex);
                  }
                  return (clientTarget.query as (...args: unknown[]) => Promise<QueryResult>)(
                    ...parameters,
                  );
                };
              }
              return Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
            },
          });
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  return { pool: proxy, queriesSeen: () => seen };
}

function buildScanner(against: Pool): ScanNetworkUseCase {
  const gateway = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });
  return new ScanNetworkUseCase({
    gateway,
    paymentRepository: new PaymentRepository(against),
    paymentTransferRepository: new PaymentTransferRepository(against),
    blockCursorRepository: new BlockCursorRepository(against),
    observedBlockRepository: new ObservedBlockRepository(against),
    chainScanStore: new ChainScanStore(against),
    ulidFactory: new UlidFactory(),
    now: () => currentTime,
  });
}

function buildEvaluator(against: Pool, claimLeaseSeconds = 30): EvaluatePaymentsUseCase {
  const gateway = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });
  return new EvaluatePaymentsUseCase({
    gateway,
    paymentRepository: new PaymentRepository(against),
    paymentTransferRepository: new PaymentTransferRepository(against),
    evaluationQueueRepository: new EvaluationQueueRepository(against),
    now: () => currentTime,
    workerIdentity: 'resilience-worker',
    ulidFactory: new UlidFactory(),
    checkoutBaseUrl: 'https://pay.cryptopay.test',
    claimLeaseSeconds,
  });
}

/**
 * INVARIANT A. Every recorded transfer sits at or below the cursor that covers its network.
 *
 * The cursor advances only inside the transaction that writes the data it covers, so a transfer
 * above the cursor would mean a restart resumes past the block holding it. That money would then
 * never be looked at again.
 */
async function transfersAboveCursor(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM payment_transfers transfer
       JOIN block_cursors cursor ON cursor.network_identifier = transfer.network_identifier
      WHERE transfer.block_height > cursor.last_scanned_height`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * INVARIANT B. A payment that changed status and asked for a callback has the delivery row for the
 * status it is now in. The two are written in one transaction, so the alternative is a payment the
 * merchant is never told about and nothing left in the outbox to retry.
 */
async function transitionsWithoutDelivery(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM payments payment
      WHERE payment.callback_url IS NOT NULL
        AND payment.status_version > 0
        AND NOT EXISTS (
          SELECT 1 FROM webhook_deliveries delivery
           WHERE delivery.payment_id = payment.id
             AND delivery.event_type = 'payment.' || payment.status::text
        )`,
  );
  return Number(result.rows[0]?.count ?? '0');
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

async function insertPayment(receivingAccount: string): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3G${paymentCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, callback_url
     ) VALUES ($1,$2,'test','local-anvil',$1,$3,'USDC',6,
               25000000,25000000,25000000,$4,'pending',2,false,0,
               $5::timestamptz + interval '30 minutes', $6)`,
    [id, MERCHANT_ID, tokenAddress, receivingAccount, currentTime.toISOString(), CALLBACK_URL],
  );
  return id;
}

async function placeCursorAtTip(): Promise<void> {
  const { createPublicClient } = await import('viem');
  const client = createPublicClient({ transport: http(rpcUrl) });
  const tip = await client.getBlock({ blockTag: 'latest' });
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
}

beforeAll(async () => {
  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress');

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'resilience');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Resilience Fixtures')`, [
    MERCHANT_ID,
  ]);
  registerLocalDevelopmentAsset('local-anvil', {
    reference: tokenAddress,
    symbol: 'USDC',
    decimals: 6,
  });

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
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  await placeCursorAtTip();
});

describe('the scanner dying mid-transaction', () => {
  /**
   * The headline assertion, and the reason the fault is injected at every index rather than at one
   * a person chose: a checkpoint picked by hand is a checkpoint picked to pass.
   */
  it('never leaves a transfer above the cursor, at any point of failure', async () => {
    const account = anvilAccount(50).address.toLowerCase();
    await insertPayment(account);
    await payTo(account, 25_000_000n);

    // How many queries a clean tick makes, so the sweep covers every one of them.
    const counting = failingPoolAt(pool, Infinity);
    await buildScanner(counting.pool).execute(FENCING_TOKEN);
    const queriesInACleanTick = counting.queriesSeen();
    expect(queriesInACleanTick).toBeGreaterThan(3);

    for (let failAt = 1; failAt <= queriesInACleanTick; failAt += 1) {
      await placeCursorAtTip();
      const faulty = failingPoolAt(pool, failAt);
      try {
        await buildScanner(faulty.pool).execute(FENCING_TOKEN);
      } catch {
        // A tick that fails is the ordinary case here; only the state it leaves behind is asserted.
      }

      expect(await transfersAboveCursor()).toBe(0);
    }
  });

  it('replays the identical window after a failure and credits once', async () => {
    const account = anvilAccount(51).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payTo(account, 25_000_000n);

    const faulty = failingPoolAt(pool, 4);
    try {
      await buildScanner(faulty.pool).execute(FENCING_TOKEN);
    } catch {
      // The failure is the point; what matters is what the next tick does.
    }

    await buildScanner(pool).execute(FENCING_TOKEN);
    await buildScanner(pool).execute(FENCING_TOKEN);

    const transfers = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM payment_transfers WHERE payment_id = $1',
      [paymentId],
    );
    expect(transfers.rows[0]?.count).toBe('1');
  });
});

describe('the evaluator dying mid-transaction', () => {
  /**
   * A completed payment nobody was told about is the failure the outbox exists to prevent, and it
   * must be unreachable rather than unlikely. There is nothing to retry afterwards: the notification
   * was never written down.
   */
  it('never leaves a status change without its callback, at any point of failure', async () => {
    const account = anvilAccount(52).address.toLowerCase();
    await insertPayment(account);
    await payTo(account, 25_000_000n);
    await buildScanner(pool).execute(FENCING_TOKEN);

    const counting = failingPoolAt(pool, Infinity);
    await buildEvaluator(counting.pool).execute();
    const queriesInACleanTick = counting.queriesSeen();
    expect(queriesInACleanTick).toBeGreaterThan(3);

    for (let failAt = 1; failAt <= queriesInACleanTick; failAt += 1) {
      await pool.query('DELETE FROM webhook_deliveries');
      await pool.query('DELETE FROM payment_status_transitions');
      await pool.query(`UPDATE payments SET status = 'pending', status_version = 0`);

      const faulty = failingPoolAt(pool, failAt);
      try {
        await buildEvaluator(faulty.pool).execute();
      } catch {
        // As above: the failure is expected, and the invariant below is what is being checked.
      }

      expect(await transitionsWithoutDelivery()).toBe(0);
    }
  });

  /**
   * A worker that died holds its claim until the lease expires, and that is the intended behaviour:
   * releasing on failure would let a worker that is merely slow have its work taken and done twice.
   * The recovery is therefore delayed rather than immediate, and the lease is set to expire at once
   * here to stand in for the time that would otherwise pass.
   */
  it('reaches the same status once the failed worker lease expires', async () => {
    const account = anvilAccount(53).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payTo(account, 25_000_000n);
    await buildScanner(pool).execute(FENCING_TOKEN);

    const faulty = failingPoolAt(pool, 3);
    try {
      await buildEvaluator(faulty.pool, 0).execute();
    } catch {
      // The failure is the point; what matters is that a later tick finishes the job.
    }
    await buildEvaluator(pool, 0).execute();

    const result = await pool.query<{ status: string; status_version: number }>(
      'SELECT status, status_version FROM payments WHERE id = $1',
      [paymentId],
    );
    expect(result.rows[0]?.status).toBe('confirming');
    expect(result.rows[0]?.status_version).toBe(1);
  });
});

describe('a provider that fails', () => {
  it('leaves the cursor exactly where it was when the chain cannot be reached', async () => {
    const unreachable = new EvmChainGateway({
      networkIdentifier: 'local-anvil',
      chainIdentifier: 31_337,
      // A port nothing listens on, so the transport fails rather than answering wrongly.
      rpcUrls: ['http://127.0.0.1:1'],
      supportsFinalityTag: false,
    });
    const scanner = new ScanNetworkUseCase({
      gateway: unreachable,
      paymentRepository: new PaymentRepository(pool),
      paymentTransferRepository: new PaymentTransferRepository(pool),
      blockCursorRepository: new BlockCursorRepository(pool),
      observedBlockRepository: new ObservedBlockRepository(pool),
      chainScanStore: new ChainScanStore(pool),
      ulidFactory: new UlidFactory(),
      now: () => currentTime,
    });

    const cursors = new BlockCursorRepository(pool);
    const before = await cursors.find('local-anvil');
    await expect(scanner.execute(FENCING_TOKEN)).rejects.toThrow();
    const after = await cursors.find('local-anvil');

    expect(after?.lastScannedHeight).toBe(before?.lastScannedHeight);
    // Not halted either: an unreachable endpoint is a transient failure, and halting on one would
    // turn every network blip into an incident that needs a human to clear.
    expect(after?.haltedAt).toBeNull();
  });
});
