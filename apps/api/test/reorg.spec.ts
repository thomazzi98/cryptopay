import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { createPublicClient, createWalletClient, http, type Abi, type Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ScanNetworkUseCase } from '../src/application/scan-network.use-case.js';
import { EvmChainGateway } from '../src/infrastructure/chain/evm-chain-gateway.js';
import { registerLocalDevelopmentAsset } from '../src/infrastructure/chain/network-configuration.js';
import { BlockCursorRepository } from '../src/infrastructure/persistence/block-cursor.repository.js';
import { ChainScanStore } from '../src/infrastructure/persistence/chain-scan.store.js';
import { ObservedBlockRepository } from '../src/infrastructure/persistence/observed-block.repository.js';
import { PaymentRepository } from '../src/infrastructure/persistence/payment.repository.js';
import { PaymentTransferRepository } from '../src/infrastructure/persistence/payment-transfer.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { anvilAccount, mineBlock } from './setup/anvil.global-setup.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Reorganisations, against a chain whose history is genuinely rewritten.
 *
 * A reorg is the one event that can make money the system already saw stop existing. The tests that
 * matter are not the dramatic ones: they are the reorg in a window that contained no transfers,
 * because that is the common case and the one a naive implementation cannot even detect, and the
 * reorg deeper than the limit, because guessing there is how a processor credits money that is gone.
 *
 * History is rewritten with a snapshot and a revert rather than with a mocked provider. A stub that
 * returns whatever the test wants proves only that the test is self-consistent.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const FENCING_TOKEN = 1n;
/** The local chain's configured limit; a fork deeper than this must halt rather than resolve. */
const MAXIMUM_REORG_DEPTH = 8;

const payer = anvilAccount(0);
const customer = anvilAccount(1);

let pool: Pool;
let dropDatabase: () => Promise<void>;
let rpcUrl: string;
let tokenAddress: string;
let tokenAbi: Abi;
let scanner: ScanNetworkUseCase;
let cursors: BlockCursorRepository;
let transfers: PaymentTransferRepository;
let paymentCounter = 0;

function publicClient() {
  return createPublicClient({ transport: http(rpcUrl) });
}

async function chainRequest(method: string, parameters: readonly unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: parameters }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${body.error.message}`);
  }
  return body.result;
}

async function takeSnapshot(): Promise<string> {
  return (await chainRequest('evm_snapshot', [])) as string;
}

/**
 * Rewinds the chain to a snapshot. Every block above it is discarded, and the blocks mined
 * afterwards occupy the same heights with different identities, which is precisely what a reorg
 * looks like from outside.
 */
async function revertTo(snapshot: string): Promise<void> {
  await chainRequest('evm_revert', [snapshot]);
  // Anvil mines deterministically, so replacement blocks with the same parent, the same timestamp
  // and the same contents hash identically. An identical chain is correctly not a reorg, so the
  // clock is moved to make the replacement history genuinely different history.
  const restored = await publicClient().getBlock({ blockTag: 'latest' });
  await chainRequest('evm_setNextBlockTimestamp', [Number(restored.timestamp) + 600]);
}

async function currentHeight(): Promise<bigint> {
  const tip = await publicClient().getBlock({ blockTag: 'latest' });
  return tip.number;
}

async function mineBlocks(count: number): Promise<void> {
  for (let mined = 0; mined < count; mined += 1) {
    await mineBlock(rpcUrl);
  }
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
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3D6${paymentCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at
     ) VALUES ($1,$2,'test','local-anvil',$1,$3,'USDC',6,
               25000000,25000000,25000000,$4,'pending',2,false,0,
               now() + interval '30 minutes')`,
    [id, MERCHANT_ID, tokenAddress, receivingAccount],
  );
  return id;
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
           current_scan_range = EXCLUDED.current_scan_range,
           consecutive_successes = 0,
           fencing_token = EXCLUDED.fencing_token,
           halted_at = NULL,
           halted_reason = NULL`,
    [tip.number.toString(), tip.hash.toLowerCase(), FENCING_TOKEN.toString()],
  );
  await pool.query(`DELETE FROM observed_blocks WHERE network_identifier = 'local-anvil'`);
  await pool.query(`DELETE FROM payment_evaluation_queue`);
}

async function readCursor() {
  const cursor = await cursors.find('local-anvil');
  if (cursor === null) {
    throw new Error('The cursor vanished');
  }
  return cursor;
}

async function countObservedHeaders(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM observed_blocks WHERE network_identifier = 'local-anvil'`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress');

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'reorg');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Reorg Fixtures')`, [MERCHANT_ID]);
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
    args: [customer.address, 100_000_000_000n],
    account: payer,
    chain: null,
  });
  await mineBlock(rpcUrl);

  const gateway = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });

  cursors = new BlockCursorRepository(pool);
  transfers = new PaymentTransferRepository(pool);
  scanner = new ScanNetworkUseCase({
    gateway,
    paymentRepository: new PaymentRepository(pool),
    paymentTransferRepository: transfers,
    blockCursorRepository: cursors,
    observedBlockRepository: new ObservedBlockRepository(pool),
    chainScanStore: new ChainScanStore(pool),
    ulidFactory: new UlidFactory(),
    now: () => new Date(),
  });
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  await placeCursorAtTip();
});

describe('a reorg in a window that held no transfers', () => {
  /**
   * The case that decides whether the header chain was worth persisting.
   *
   * Almost every reorg happens in a window containing none of our payments. An implementation that
   * looks for the fork by walking payment rows finds nothing to compare, exhausts its depth limit
   * and halts a network that is perfectly healthy. Walking headers finds the fork immediately.
   */
  it('detects the fork and rewinds without halting', async () => {
    const snapshot = await takeSnapshot();
    const forkHeight = await currentHeight();

    await mineBlocks(3);
    const firstScan = await scanner.execute(FENCING_TOKEN);
    expect(firstScan.kind).toBe('scanned');
    expect(await countObservedHeaders()).toBeGreaterThan(0);

    await revertTo(snapshot);
    await mineBlocks(3);

    const afterFork = await scanner.execute(FENCING_TOKEN);

    expect(afterFork.kind).toBe('rewound');
    const rewound = await readCursor();
    expect(rewound.lastScannedHeight).toBe(forkHeight);
    expect(rewound.haltedAt).toBeNull();
  });

  it('discards the headers it had recorded above the fork', async () => {
    const snapshot = await takeSnapshot();
    const forkHeight = await currentHeight();

    await mineBlocks(3);
    await scanner.execute(FENCING_TOKEN);

    await revertTo(snapshot);
    await mineBlocks(3);
    await scanner.execute(FENCING_TOKEN);

    const remaining = await pool.query<{ block_height: string }>(
      `SELECT block_height FROM observed_blocks
        WHERE network_identifier = 'local-anvil' AND block_height > $1`,
      [forkHeight.toString()],
    );
    expect(remaining.rowCount).toBe(0);
  });

  it('resumes scanning the replacement blocks on the following tick', async () => {
    const snapshot = await takeSnapshot();
    await mineBlocks(3);
    await scanner.execute(FENCING_TOKEN);

    await revertTo(snapshot);
    await mineBlocks(3);
    await scanner.execute(FENCING_TOKEN);

    const resumed = await scanner.execute(FENCING_TOKEN);
    expect(resumed.kind).toBe('scanned');
    const cursor = await readCursor();
    expect(cursor.lastScannedHeight).toBe(await currentHeight());
  });
});

describe('a reorg that withdraws credited money', () => {
  it('marks the transfer orphaned rather than deleting it', async () => {
    const account = anvilAccount(20).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const snapshot = await takeSnapshot();

    await payTo(account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);
    expect(await transfers.findByPayment(paymentId)).toHaveLength(1);

    await revertTo(snapshot);
    await mineBlocks(2);
    const afterFork = await scanner.execute(FENCING_TOKEN);

    expect(afterFork).toMatchObject({ kind: 'rewound', orphanedTransfers: 1 });
    const recorded = await transfers.findByPayment(paymentId);
    // Kept and struck through, never hidden. A customer whose transfer was withdrawn by a reorg is
    // owed an explanation, and support cannot give one for a row that was deleted.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ observation: 'orphaned', orphaned: true });
  });

  it('queues the payment so its credited total is recomputed', async () => {
    const account = anvilAccount(21).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const snapshot = await takeSnapshot();

    await payTo(account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);
    await pool.query('DELETE FROM payment_evaluation_queue');

    await revertTo(snapshot);
    await mineBlocks(2);
    await scanner.execute(FENCING_TOKEN);

    const queued = await pool.query(
      'SELECT payment_id FROM payment_evaluation_queue WHERE payment_id = $1',
      [paymentId],
    );
    expect(queued.rowCount).toBe(1);
  });

  /**
   * The transfer is usually re-mined into the replacement chain, because the transaction returns to
   * the mempool. It must then be credited again exactly once, at its new position: the orphaned row
   * stays, and a new row is written under the new block.
   */
  it('credits the transfer again once it is re-mined', async () => {
    const account = anvilAccount(22).address.toLowerCase();
    const paymentId = await insertPayment(account);
    const snapshot = await takeSnapshot();

    await payTo(account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    await revertTo(snapshot);
    await scanner.execute(FENCING_TOKEN);
    await payTo(account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    const recorded = await transfers.findByPayment(paymentId);
    const surviving = recorded.filter((entry) => !entry.orphaned);
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.amountInBaseUnits).toBe(25_000_000n);
  });
});

describe('a reorg deeper than the limit', () => {
  /**
   * Beyond the configured depth the scanner cannot establish what the canonical chain was, so it
   * stops and pages a human. Continuing to guess during an anomaly is precisely how a processor
   * credits money that no longer exists, and the cost of stopping is a few minutes of delay.
   */
  it('halts instead of guessing', async () => {
    const snapshot = await takeSnapshot();

    await mineBlocks(MAXIMUM_REORG_DEPTH + 4);
    await scanner.execute(FENCING_TOKEN);

    await revertTo(snapshot);
    await mineBlocks(MAXIMUM_REORG_DEPTH + 4);
    const outcome = await scanner.execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('halted');
    const halted = await readCursor();
    expect(halted.haltedAt).not.toBeNull();
  });

  it('refuses every later tick until an operator resumes it', async () => {
    const snapshot = await takeSnapshot();
    await mineBlocks(MAXIMUM_REORG_DEPTH + 4);
    await scanner.execute(FENCING_TOKEN);
    await revertTo(snapshot);
    await mineBlocks(MAXIMUM_REORG_DEPTH + 4);
    await scanner.execute(FENCING_TOKEN);

    const secondTick = await scanner.execute(FENCING_TOKEN);
    const thirdTick = await scanner.execute(FENCING_TOKEN);
    expect(secondTick.kind).toBe('halted');
    expect(thirdTick.kind).toBe('halted');

    await cursors.resume('local-anvil');
    const resumed = await readCursor();
    expect(resumed.haltedAt).toBeNull();
  });
});

/**
 * The reorg that happens between reading the logs and reading the headers.
 *
 * This one cannot be produced by rewriting history, because it is a race inside a single scan: the
 * logs come from one request and the headers from another, seconds later on a slow endpoint. If a
 * block is replaced in between, the result is internally inconsistent and looks perfectly fine — the
 * transfer carries a block reference that no longer exists, while the header recorded for that
 * height is its replacement. Fork resolution walks headers alone, compares the replacement against
 * the chain, finds them equal, and never rewinds.
 *
 * So the inconsistency is injected rather than raced for: one real scan result, one field changed,
 * everything else genuine. That is the same shape the resilience suite uses, and it is the only way
 * to assert on a window this code must refuse.
 */
function scannerWithCorruptedTransferReference(corrupt: boolean) {
  const honest = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });

  const gateway = Object.create(honest) as EvmChainGateway;
  gateway.scanIncomingTransfers = async (request) => {
    const result = await honest.scanIncomingTransfers(request);
    if (!corrupt || result.transfers.length === 0) {
      return result;
    }
    return {
      ...result,
      transfers: result.transfers.map((transfer) => ({
        ...transfer,
        position: { ...transfer.position, reference: `0x${'e'.repeat(64)}` },
      })),
    };
  };

  return new ScanNetworkUseCase({
    gateway,
    paymentRepository: new PaymentRepository(pool),
    paymentTransferRepository: transfers,
    blockCursorRepository: cursors,
    observedBlockRepository: new ObservedBlockRepository(pool),
    chainScanStore: new ChainScanStore(pool),
    ulidFactory: new UlidFactory(),
    now: () => new Date(),
  });
}

describe('a scan whose logs and headers disagree', () => {
  it('refuses the window, credits nothing, and leaves the cursor where it was', async () => {
    const account = anvilAccount(24).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payTo(account, 25_000_000n);

    const before = await readCursor();
    const outcome = await scannerWithCorruptedTransferReference(true).execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('discarded');
    const stored = await pool.query('SELECT 1 FROM payment_transfers WHERE payment_id = $1', [
      paymentId,
    ]);
    expect(stored.rowCount).toBe(0);
    const after = await readCursor();
    expect(after.lastScannedHeight).toBe(before.lastScannedHeight);
    expect(after.haltedAt).toBeNull();
  });

  /**
   * Discarding is not halting. The same range is read again, and once the endpoint answers
   * consistently the money is credited exactly once.
   */
  it('credits the transfer on the next tick, once the reads agree', async () => {
    const account = anvilAccount(25).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payTo(account, 25_000_000n);

    const refused = await scannerWithCorruptedTransferReference(true).execute(FENCING_TOKEN);
    expect(refused.kind).toBe('discarded');

    const recovered = await scannerWithCorruptedTransferReference(false).execute(FENCING_TOKEN);
    expect(recovered.kind).toBe('scanned');

    const credited = await pool.query<{ amount: string }>(
      'SELECT amount FROM payment_transfers WHERE payment_id = $1',
      [paymentId],
    );
    expect(credited.rowCount).toBe(1);
    expect(credited.rows[0]?.amount).toBe('25000000');
  });
});

/**
 * The difference between "the block is gone" and "nobody answered".
 *
 * Fork resolution reads block headers from the chain. When those reads failed, every cause was
 * treated as a pruned node, and a pruned node is unresolvable: the network halted and stayed halted
 * until an operator resumed it by hand. A halt freezes completion and expiry for every payment on
 * that network, so a rate limit lasting seconds became an outage lasting until someone noticed.
 */
function scannerWhoseHeaderReadsFail(reason: string) {
  const honest = new EvmChainGateway({
    networkIdentifier: 'local-anvil',
    chainIdentifier: 31_337,
    rpcUrls: [rpcUrl],
    supportsFinalityTag: false,
  });

  // The adapter's own classification is asserted separately, against a real unreachable endpoint.
  // Here the question is what the use case does with the answer.
  const gateway = Object.create(honest) as EvmChainGateway;
  gateway.readPositionAtHeight = () => Promise.resolve({ kind: 'unavailable', reason });

  return new ScanNetworkUseCase({
    gateway,
    paymentRepository: new PaymentRepository(pool),
    paymentTransferRepository: transfers,
    blockCursorRepository: cursors,
    observedBlockRepository: new ObservedBlockRepository(pool),
    chainScanStore: new ChainScanStore(pool),
    ulidFactory: new UlidFactory(),
    now: () => new Date(),
  });
}

describe('an endpoint that stops answering during fork resolution', () => {
  beforeEach(async () => {
    // A header on record is what makes fork resolution run at all.
    await mineBlocks(2);
    await scanner.execute(FENCING_TOKEN);
  });

  it('does not halt the network when the endpoint times out', async () => {
    const outcome =
      await scannerWhoseHeaderReadsFail('the request timed out').execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('discarded');
    const cursor = await readCursor();
    expect(cursor.haltedAt).toBeNull();
  });

  it('does not halt the network when the endpoint refuses the request', async () => {
    const outcome = await scannerWhoseHeaderReadsFail('rate limited').execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('discarded');
    const cursor = await readCursor();
    expect(cursor.haltedAt).toBeNull();
  });

  it('scans normally again once the endpoint recovers', async () => {
    await scannerWhoseHeaderReadsFail('the request timed out').execute(FENCING_TOKEN);
    await mineBlocks(1);

    const recovered = await scanner.execute(FENCING_TOKEN);
    expect(recovered.kind).toBe('scanned');
    const cursor = await readCursor();
    expect(cursor.haltedAt).toBeNull();
  });
});
