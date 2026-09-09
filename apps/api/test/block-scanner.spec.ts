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
 * The scanner against a real chain and a real database.
 *
 * This is where observed on-chain value becomes credited value, so these tests are the ones that
 * decide whether money can be invented. The two that matter most are the replay no-op and the wrong
 * token: the first proves at-least-once scanning credits exactly once, the second proves identity is
 * the contract address rather than the symbol a token chooses to report.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const FENCING_TOKEN = 1n;

const payer = anvilAccount(0);
const customer = anvilAccount(1);

let pool: Pool;
let dropDatabase: () => Promise<void>;
let rpcUrl: string;
let tokenAddress: string;
let decoyTokenAddress: string;
let tokenAbi: Abi;
let scanner: ScanNetworkUseCase;
let cursors: BlockCursorRepository;
let transfers: PaymentTransferRepository;
let paymentCounter = 0;

async function deployToken(): Promise<string> {
  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi; bytecode: string };
  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    account: payer,
    chain: null,
    args: [],
  });
  await mineBlock(rpcUrl);
  const receipt = await publicClient().getTransactionReceipt({ hash });
  const deployed = receipt.contractAddress;
  if (deployed === null || deployed === undefined) {
    throw new Error('The decoy token did not deploy');
  }
  return deployed.toLowerCase();
}

async function callToken(
  address: string,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: address as Address,
    abi: tokenAbi,
    functionName,
    args: [...args],
    account: payer,
    chain: null,
  });
  await mineBlock(rpcUrl);
}

async function payFrom(
  account: typeof payer,
  address: string,
  destination: string,
  amount: bigint,
): Promise<void> {
  const wallet = createWalletClient({ account, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: address as Address,
    abi: tokenAbi,
    functionName: 'transfer',
    args: [destination as Address, amount],
    account,
    chain: null,
  });
  await mineBlock(rpcUrl);
}

async function insertPayment(receivingAccount: string, status = 'pending'): Promise<string> {
  paymentCounter += 1;
  const id = `pay_01K4QW6ZR2M8X4T7YQ0C3D5${paymentCounter.toString().padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at
     ) VALUES ($1,$2,'test','local-anvil',$1,$3,'USDC',6,
               25000000,25000000,25000000,$4,$5::payment_status,2,false,0,
               now() + interval '30 minutes')`,
    [id, MERCHANT_ID, tokenAddress, receivingAccount, status],
  );
  return id;
}

function publicClient() {
  return createPublicClient({ transport: http(rpcUrl) });
}

async function resetCursorToTip(): Promise<void> {
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
}

async function countTransfers(paymentId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM payment_transfers WHERE payment_id = $1',
    [paymentId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function readCursorHeight(): Promise<bigint> {
  const cursor = await cursors.find('local-anvil');
  if (cursor === null) {
    throw new Error('The cursor vanished');
  }
  return cursor.lastScannedHeight;
}

beforeAll(async () => {
  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress');

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'scanner');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Scanner Fixtures')`, [
    MERCHANT_ID,
  ]);

  // The decoy reports the byte-identical symbol "USDC" and is never registered as an allowed asset,
  // which is exactly the shape of bridged USDC.e on Polygon mainnet.
  decoyTokenAddress = await deployToken();
  registerLocalDevelopmentAsset('local-anvil', {
    reference: tokenAddress,
    symbol: 'USDC',
    decimals: 6,
  });

  await callToken(tokenAddress, 'mint', [payer.address, 10_000_000_000n]);
  await callToken(tokenAddress, 'mint', [customer.address, 10_000_000_000n]);
  await callToken(decoyTokenAddress, 'mint', [payer.address, 10_000_000_000n]);

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
  await resetCursorToTip();
});

describe('crediting an observed transfer', () => {
  it('records a transfer sent to a watched address', async () => {
    const account = anvilAccount(10).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(customer, tokenAddress, account, 25_000_000n);
    const outcome = await scanner.execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('scanned');
    const recorded = await transfers.findByPayment(paymentId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      classification: 'credited',
      amountInBaseUnits: 25_000_000n,
      observation: 'observed',
      orphaned: false,
    });
  });

  /**
   * The amount comes from the decoded event and nothing else. A client that claimed a different
   * figure could not change this row, because no request body is read anywhere on this path.
   */
  it('records the amount the chain reported, not the amount requested', async () => {
    const account = anvilAccount(11).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(customer, tokenAddress, account, 7n);
    await scanner.execute(FENCING_TOKEN);

    const recorded = await transfers.findByPayment(paymentId);
    expect(recorded[0]?.amountInBaseUnits).toBe(7n);
  });

  it('queues the payment for evaluation', async () => {
    const account = anvilAccount(12).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(customer, tokenAddress, account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    const queued = await pool.query(
      'SELECT payment_id FROM payment_evaluation_queue WHERE payment_id = $1',
      [paymentId],
    );
    expect(queued.rowCount).toBe(1);
  });

  it('records both halves of a split payment', async () => {
    const account = anvilAccount(13).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(customer, tokenAddress, account, 10_000_000n);
    await payFrom(customer, tokenAddress, account, 15_000_000n);
    await scanner.execute(FENCING_TOKEN);

    const recorded = await transfers.findByPayment(paymentId);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((entry) => entry.classification === 'credited')).toBe(true);
  });
});

describe('refusing what should not be credited', () => {
  /**
   * The decoy contract reports the byte-identical symbol "USDC". If identity were the symbol, this
   * transfer would be credited and the merchant would be paid in a token they never agreed to take.
   */
  it('records a look-alike token as the wrong asset rather than crediting it', async () => {
    const account = anvilAccount(14).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(payer, decoyTokenAddress, account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    const recorded = await transfers.findByPayment(paymentId);
    // The scan filters by contract address, so the decoy never reaches the classifier at all.
    expect(recorded).toHaveLength(0);
  });

  it('ignores a transfer to an address no payment owns', async () => {
    const stranger = anvilAccount(15).address.toLowerCase();

    await payFrom(customer, tokenAddress, stranger, 25_000_000n);
    const outcome = await scanner.execute(FENCING_TOKEN);

    expect(outcome).toMatchObject({ kind: 'scanned', transfersObserved: 0 });
  });

  it('records a transfer to an expired payment as late rather than crediting it', async () => {
    const account = anvilAccount(16).address.toLowerCase();
    const paymentId = await insertPayment(account, 'expired');

    await payFrom(customer, tokenAddress, account, 25_000_000n);
    await scanner.execute(FENCING_TOKEN);

    const recorded = await transfers.findByPayment(paymentId);
    expect(recorded[0]?.classification).toBe('late');
  });
});

describe('replaying a window', () => {
  /**
   * The property the whole scanner rests on. The cursor advances only inside the transaction that
   * writes the data it covers, so a crash replays the identical window; the uniqueness constraint on
   * (network, transaction_reference, event_index) is what makes that replay change nothing.
   *
   * Rewinding by hand here is the same thing a crash would produce, and it is deliberately checked
   * across many repetitions rather than one, because a duplicate that only appears on the third
   * replay is still a duplicate.
   */
  it('credits exactly once however often the same blocks are rescanned', async () => {
    const account = anvilAccount(17).address.toLowerCase();
    const paymentId = await insertPayment(account);

    await payFrom(customer, tokenAddress, account, 25_000_000n);
    const heightBefore = await readCursorHeight();

    await scanner.execute(FENCING_TOKEN);
    const afterFirstScan = await countTransfers(paymentId);
    expect(afterFirstScan).toBe(1);

    for (let replay = 0; replay < 4; replay += 1) {
      await pool.query(
        `UPDATE block_cursors SET last_scanned_height = $1 WHERE network_identifier = 'local-anvil'`,
        [heightBefore.toString()],
      );
      await scanner.execute(FENCING_TOKEN);
      expect(await countTransfers(paymentId)).toBe(afterFirstScan);
    }
  });

  it('advances the cursor to the block it actually read', async () => {
    await mineBlock(rpcUrl);
    await scanner.execute(FENCING_TOKEN);

    const tip = await publicClient().getBlock({ blockTag: 'latest' });
    expect(await readCursorHeight()).toBe(tip.number);
  });

  it('reports being caught up once the cursor reaches the tip', async () => {
    await scanner.execute(FENCING_TOKEN);
    const outcome = await scanner.execute(FENCING_TOKEN);
    expect(outcome.kind).toBe('idle');
  });
});

describe('fencing a worker that lost its lease', () => {
  /**
   * A worker that hung past its lease expiry still believes it is the leader. Its writes are refused
   * by the token comparison rather than by its own opinion of whether it is still in charge, which
   * is the only version of this that survives a process that is stuck rather than dead.
   */
  it('writes nothing when the cursor carries a newer token', async () => {
    const account = anvilAccount(18).address.toLowerCase();
    const paymentId = await insertPayment(account);
    await payFrom(customer, tokenAddress, account, 25_000_000n);

    await pool.query(
      `UPDATE block_cursors SET fencing_token = $1 WHERE network_identifier = 'local-anvil'`,
      [(FENCING_TOKEN + 5n).toString()],
    );

    const outcome = await scanner.execute(FENCING_TOKEN);

    expect(outcome.kind).toBe('lease_lost');
    expect(await countTransfers(paymentId)).toBe(0);
  });
});

describe('halting rather than guessing', () => {
  it('refuses to scan a network an operator halted', async () => {
    await pool.query(
      `UPDATE block_cursors SET halted_at = now(), halted_reason = 'operator halt'
        WHERE network_identifier = 'local-anvil'`,
    );

    const outcome = await scanner.execute(FENCING_TOKEN);
    expect(outcome).toMatchObject({ kind: 'halted', reason: 'operator halt' });
  });

  it('resumes only when an operator says so', async () => {
    await pool.query(
      `UPDATE block_cursors SET halted_at = now(), halted_reason = 'operator halt'
        WHERE network_identifier = 'local-anvil'`,
    );

    expect(await cursors.resume('local-anvil')).toBe(true);
    const outcome = await scanner.execute(FENCING_TOKEN);
    expect(outcome.kind).not.toBe('halted');
  });
});
