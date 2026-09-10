import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { pino } from 'pino';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type Abi,
} from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { SettlePaymentsUseCase } from '../src/application/settle-payments.use-case.js';
import { EvmChainGateway } from '../src/infrastructure/chain/evm-chain-gateway.js';
import { EvmSettlementBroadcaster } from '../src/infrastructure/chain/evm-settlement-broadcaster.js';
import { registerLocalDevelopmentAsset } from '../src/infrastructure/chain/network-configuration.js';
import { SettlementRepository } from '../src/infrastructure/persistence/settlement.repository.js';
import { WalletSeedRepository } from '../src/infrastructure/persistence/wallet-seed.repository.js';
import { UlidFactory } from '../src/infrastructure/system/ulid.js';
import { HierarchicalDeterministicAllocator } from '../src/infrastructure/wallet/hierarchical-deterministic-allocator.js';
import {
  createKeyWrapperRegistry,
  createLocalKeyWrapper,
} from '../src/infrastructure/wallet/key-wrapping.js';
import { generateMasterSeed, sealSeed } from '../src/infrastructure/wallet/master-seed.js';
import { WalletSigningProvider } from '../src/infrastructure/wallet/signing-provider.js';
import { anvilAccount, mineBlock } from './setup/anvil.global-setup.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Settlement against a real chain: real signatures, real broadcasts, real receipts.
 *
 * This is the half of the system that spends. Every other suite can be wrong and cost a merchant a
 * report; this one can be wrong and cost them the money itself, so nothing here is stubbed. The keys
 * are derived from a sealed seed by the same provider production uses, the transactions are signed
 * by viem and sent to a node, and the assertions are about what the token contract says afterwards.
 *
 * Anvil mines only when a test tells it to, so every confirmation count is exact and no test sleeps.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const WALLET_KEY = Buffer.alloc(32, 7);
const NETWORK = 'local-anvil';
const ENVIRONMENT = 'test';
/** The local chain's configured policy, mirrored so the assertions state what they depend on. */
const REQUIRED_CONFIRMATIONS = 2;

const payer = anvilAccount(0);

/**
 * An address the allocator tests claim against, never the treasury.
 *
 * A claim advances a counter that the chain cannot catch up to unless the number is actually used,
 * so claiming eight numbers for the treasury and using none of them leaves a hole every later
 * treasury transaction queues behind — which is the very failure the engine guards against, and it
 * would be the test causing it rather than the code.
 */
const ALLOCATOR_PROBE_ACCOUNT = '0x00000000000000000000000000000000000a110c';
const payoutAccount = anvilAccount(9).address.toLowerCase();

let pool: Pool;
let dropDatabase: () => Promise<void>;
let rpcUrl: string;
let tokenAddress: string;
let tokenAbi: Abi;
let settler: SettlePaymentsUseCase;
let broadcaster: EvmSettlementBroadcaster;
let repository: SettlementRepository;
let allocator: HierarchicalDeterministicAllocator;
let paymentCounter = 0;

const ulidFactory = new UlidFactory();
const logger = pino({ level: 'silent' });

function publicClient() {
  return createPublicClient({ transport: http(rpcUrl) });
}

async function mine(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await mineBlock(rpcUrl);
  }
}

async function mintTo(account: string, amount: bigint): Promise<void> {
  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  await wallet.writeContract({
    address: getAddress(tokenAddress),
    abi: tokenAbi,
    functionName: 'mint',
    args: [getAddress(account), amount],
    chain: null,
  });
  await mine();
}

async function fundNative(account: string, amount: bigint): Promise<void> {
  const wallet = createWalletClient({ account: payer, transport: http(rpcUrl) });
  await wallet.sendTransaction({
    to: getAddress(account),
    value: amount,
    chain: null,
  });
  await mine();
}

async function tokenBalanceOf(account: string): Promise<bigint> {
  return publicClient().readContract({
    address: getAddress(tokenAddress),
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [getAddress(account)],
  }) as Promise<bigint>;
}

/**
 * A completed payment whose deposit address is derived from the same seed the signer will use, so
 * the test proves the two halves of the wallet agree rather than assuming it.
 */
async function insertSettleablePayment(
  derivationIndex: number,
  status = 'completed',
): Promise<{ paymentId: string; depositAccount: string }> {
  paymentCounter += 1;
  const paymentId = `pay_01K4QW6ZR2M8X4T7YQ0C3E9${paymentCounter.toString().padStart(3, '0')}`;
  const allocated = allocator.allocate(derivationIndex);

  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, completed_at
     ) VALUES ($1,$2,'test','local-anvil',$1,$3,'USDC',6,
               25000000,25000000,25000000,$4,$5::payment_status,2,false,1,
               now() + interval '30 minutes',
               CASE WHEN $5 = 'completed' THEN now() END)`,
    [paymentId, MERCHANT_ID, tokenAddress, allocated.account, status],
  );
  await pool.query(
    `INSERT INTO payment_addresses
       (id, payment_id, environment, network_identifier, account, derivation_index,
        allocation_reference)
     VALUES ($1,$2,'test','local-anvil',$3,$4,$5)`,
    [
      `adr_${paymentId.slice(4)}`,
      paymentId,
      allocated.account,
      derivationIndex,
      allocated.allocationReference,
    ],
  );
  return { paymentId, depositAccount: allocated.account };
}

function buildSettler(spendCeilingInNativeUnits: bigint | null): SettlePaymentsUseCase {
  return new SettlePaymentsUseCase({
    networkIdentifier: NETWORK,
    gateway: new EvmChainGateway({
      networkIdentifier: NETWORK,
      chainIdentifier: 31_337,
      rpcUrls: [rpcUrl],
      supportsFinalityTag: false,
    }),
    broadcaster,
    settlementRepository: repository,
    ulidFactory,
    logger,
    now: () => new Date(),
    spendCeilingInNativeUnits,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    requiresFinalityTag: false,
    maximumAttempts: 5,
    retryBackoffMilliseconds: 0,
    batchSize: 10,
  });
}

/** Drives the settlement to completion the way the worker does: tick, mine, tick. */
async function settleFully(useCase: SettlePaymentsUseCase, ticks = 8): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await useCase.retryFailed();
    await useCase.execute();
    await mine(REQUIRED_CONFIRMATIONS);
  }
}

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'settlement');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  rpcUrl = `http://127.0.0.1:${inject('anvilPort').toString()}`;
  tokenAddress = inject('anvilTokenAddress').toLowerCase();
  registerLocalDevelopmentAsset('local-anvil', {
    reference: tokenAddress,
    symbol: 'USDC',
    decimals: 6,
  });

  const artifact = JSON.parse(
    await readFile(resolve(packageRoot, 'test/fixtures/mock-usdc.json'), 'utf8'),
  ) as { abi: Abi };
  tokenAbi = artifact.abi;

  await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Settlement Fixtures')`, [
    MERCHANT_ID,
  ]);
  await pool.query(
    `INSERT INTO payout_destinations (merchant_id, environment, network_identifier, account)
     VALUES ($1,'test','local-anvil',$2)`,
    [MERCHANT_ID, payoutAccount],
  );
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('local-anvil', 1, '0xabc', 20)`,
  );

  const seed = generateMasterSeed();
  const wrapper = createLocalKeyWrapper(WALLET_KEY, 'local-key-1');
  const seedRepository = new WalletSeedRepository(pool);
  await seedRepository.storeIfAbsent(
    'sed_01K4QW6ZR2M8X4T7YQ0C3E9001',
    ENVIRONMENT,
    sealSeed(seed, ENVIRONMENT, wrapper),
  );
  allocator = new HierarchicalDeterministicAllocator(seed, 'polygon');

  const signingProvider = new WalletSigningProvider(
    seedRepository,
    createKeyWrapperRegistry(WALLET_KEY, 'local-key-1'),
  );
  const treasuryAccount = await signingProvider.treasuryAccount(ENVIRONMENT);

  broadcaster = new EvmSettlementBroadcaster({
    networkIdentifier: NETWORK,
    chainIdentifier: 31_337,
    displayName: 'Local Anvil',
    nativeCurrencySymbol: 'ETH',
    nativeCurrencyDecimals: 18,
    rpcUrls: [rpcUrl],
    environment: ENVIRONMENT,
    signingProvider,
    treasuryAccount,
  });

  repository = new SettlementRepository(pool);
  settler = buildSettler(null);

  // The treasury pays for every gas drip, so it is funded once here exactly as an operator would.
  await fundNative(treasuryAccount, parseEther('10'));
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  // Payments go too. Deleting only the settlements would make every deposit address from an earlier
  // test settleable again, and the engine would correctly sweep money the test was not asking about.
  await pool.query('DELETE FROM chain_transactions');
  await pool.query('DELETE FROM settlements');
  await pool.query('DELETE FROM payments');
});

describe('sweeping a completed payment', () => {
  it('moves the money to the payout account and records what it cost', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1000);
    await mintTo(depositAccount, 25_000_000n);
    const payoutBefore = await tokenBalanceOf(payoutAccount);

    await settleFully(settler);

    expect(await tokenBalanceOf(depositAccount)).toBe(0n);
    expect(await tokenBalanceOf(payoutAccount)).toBe(payoutBefore + 25_000_000n);

    const settlement = await repository.findByPayment(paymentId);
    expect(settlement?.status).toBe('settled');
    expect(settlement?.amountInBaseUnits).toBe(25_000_000n);

    const transactions = await repository.transactionsFor(settlement?.identifier ?? '');
    expect(transactions.map((entry) => entry.purpose)).toStrictEqual([
      'gas_funding',
      'asset_sweep',
    ]);
    for (const transaction of transactions) {
      expect(transaction.status).toBe('confirmed');
      expect(transaction.feePaidInNativeUnits).not.toBeNull();
      expect(transaction.blockHeight).not.toBeNull();
    }
  });

  /**
   * The amount comes from the chain, not from what the payment says it was owed. An overpayment
   * leaves more in the address than the invoice, and sweeping the invoice would strand the rest.
   */
  it('sweeps the balance that is actually there, not the amount invoiced', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1001, 'overpaid');
    await mintTo(depositAccount, 31_000_000n);

    await settleFully(settler);

    expect(await tokenBalanceOf(depositAccount)).toBe(0n);
    const settlement = await repository.findByPayment(paymentId);
    expect(settlement?.amountInBaseUnits).toBe(31_000_000n);
    expect(settlement?.status).toBe('settled');
  });

  it('holds at confirming until the sweep has the confirmations the network requires', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1002);
    await mintTo(depositAccount, 25_000_000n);

    // Funding, then the sweep, then one block: mined but not yet confirmed to the required depth.
    await settler.execute();
    await mine();
    await settler.execute();
    await mine();
    await settler.execute();

    const settlement = await repository.findByPayment(paymentId);
    expect(settlement?.status).toBe('confirming');
    expect(settlement?.settledAt).toBeNull();
  });
});

/**
 * The money is in an address this system controls whatever the payment's status says. Leaving it
 * there because the invoice expired does not preserve anyone's options: a deposit address is used
 * once and nothing will ever look at it again.
 */
describe('recovering funds from a payment that did not complete', () => {
  it.each(['expired', 'canceled', 'underpaid'])(
    'sweeps a %s payment that still holds a balance',
    async (status) => {
      paymentCounter += 1;
      const { depositAccount } = await insertSettleablePayment(1100 + paymentCounter, status);
      await mintTo(depositAccount, 4_000_000n);
      const payoutBefore = await tokenBalanceOf(payoutAccount);

      await settleFully(settler);

      expect(await tokenBalanceOf(depositAccount)).toBe(0n);
      expect(await tokenBalanceOf(payoutAccount)).toBe(payoutBefore + 4_000_000n);
    },
  );

  it('costs one balance read and no transaction for an address holding nothing', async () => {
    const { paymentId } = await insertSettleablePayment(1200, 'expired');

    const outcome = await settler.execute();

    expect(outcome.planned).toBe(0);
    expect(outcome.broadcast).toBe(0);
    expect(await repository.findByPayment(paymentId)).toBeNull();
  });
});

describe('paying twice', () => {
  /**
   * The property the whole engine exists to hold. Ticking repeatedly, which is exactly what the
   * worker does, must move the money once.
   */
  it('never sends a second sweep however many times it runs', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1300);
    await mintTo(depositAccount, 25_000_000n);
    const payoutBefore = await tokenBalanceOf(payoutAccount);

    await settleFully(settler, 12);

    expect(await tokenBalanceOf(payoutAccount)).toBe(payoutBefore + 25_000_000n);
    const settlement = await repository.findByPayment(paymentId);
    const transactions = await repository.transactionsFor(settlement?.identifier ?? '');
    const sweeps = transactions.filter((entry) => entry.purpose === 'asset_sweep');
    expect(sweeps).toHaveLength(1);
  });

  it('plans one settlement per payment even when asked repeatedly', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1301);
    await mintTo(depositAccount, 25_000_000n);

    await settler.execute();
    await settler.execute();

    const rows = await pool.query('SELECT 1 FROM settlements WHERE payment_id = $1', [paymentId]);
    expect(rows.rowCount).toBe(1);
  });

  /**
   * Two workers, one network. The sequence allocator serialises them and the partial unique index
   * refuses the loser, so the same slot cannot be signed twice.
   */
  it('gives two concurrent settlers different sequence numbers', async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0),
      ),
    );

    expect(new Set(claims).size).toBe(claims.length);
  });
});

describe('the spend ceiling', () => {
  it('refuses to sign when funding would cross it, and says so on the settlement', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1400);
    await mintTo(depositAccount, 25_000_000n);

    // One wei: any real funding transfer exceeds it.
    const outcome = await buildSettler(1n).execute();

    expect(outcome.failed).toBe(1);
    const settlement = await repository.findByPayment(paymentId);
    expect(settlement?.status).toBe('failed');
    expect(settlement?.failureReason).toContain('spend ceiling');
    expect(await tokenBalanceOf(depositAccount)).toBe(25_000_000n);
  });

  it('signs nothing at all when it refuses', async () => {
    const { depositAccount } = await insertSettleablePayment(1401);
    await mintTo(depositAccount, 25_000_000n);

    await buildSettler(1n).execute();

    const rows = await pool.query('SELECT 1 FROM chain_transactions');
    expect(rows.rowCount).toBe(0);
  });

  it('permits the settlement once the ceiling is raised', async () => {
    const { depositAccount } = await insertSettleablePayment(1402);
    await mintTo(depositAccount, 25_000_000n);

    await buildSettler(1n).execute();
    await settleFully(buildSettler(parseEther('1')));

    expect(await tokenBalanceOf(depositAccount)).toBe(0n);
  });
});

describe('refusing to sign for the wrong chain or the wrong account', () => {
  it('refuses when the endpoint serves a different chain than the one configured', async () => {
    const wrongChain = new EvmSettlementBroadcaster({
      networkIdentifier: NETWORK,
      chainIdentifier: 137,
      displayName: 'Polygon',
      nativeCurrencySymbol: 'POL',
      nativeCurrencyDecimals: 18,
      rpcUrls: [rpcUrl],
      environment: ENVIRONMENT,
      signingProvider: new WalletSigningProvider(
        new WalletSeedRepository(pool),
        createKeyWrapperRegistry(WALLET_KEY, 'local-key-1'),
      ),
      treasuryAccount: broadcaster.treasuryAccount,
    });

    await expect(wrongChain.assertLedgerIdentity()).rejects.toThrow(/reported chain 31337/);
  });

  /**
   * A signature is valid on every EVM chain at once, so the account the key derives must be the
   * account the caller named. Signing for someone else's address is not an error the chain reports.
   */
  it('refuses to sign for an account this seed does not control', async () => {
    const stranger = anvilAccount(15).address.toLowerCase();
    const estimate = await broadcaster.estimateNativeTransfer({
      signingRole: { kind: 'treasury' },
      sourceAccount: broadcaster.treasuryAccount,
      destinationAccount: stranger,
      amountInNativeUnits: 1n,
    });
    expect(estimate.kind).toBe('estimated');
    if (estimate.kind !== 'estimated') {
      return;
    }

    const signed = await broadcaster.signNativeTransfer(
      {
        signingRole: { kind: 'treasury' },
        sourceAccount: stranger,
        destinationAccount: broadcaster.treasuryAccount,
        amountInNativeUnits: 1n,
      },
      0,
      estimate.estimate,
    );

    expect(signed.kind).toBe('refused');
  });
});

describe('what an operator can see afterwards', () => {
  it('records the fee actually paid, not the estimate', async () => {
    const { paymentId, depositAccount } = await insertSettleablePayment(1500);
    await mintTo(depositAccount, 25_000_000n);

    await settleFully(settler);

    const settlement = await repository.findByPayment(paymentId);
    const transactions = await repository.transactionsFor(settlement?.identifier ?? '');
    // Asserted before the loop, because every assertion about a fee lives inside it and a settlement
    // that broadcast nothing would satisfy all of them by having nothing to check.
    expect(transactions.length).toBeGreaterThan(0);
    for (const transaction of transactions) {
      expect(transaction.feePaidInNativeUnits).not.toBeNull();
      expect(transaction.feePaidInNativeUnits ?? 0n).toBeLessThanOrEqual(
        transaction.maximumFeeInNativeUnits,
      );
      expect(transaction.computeUsed ?? 0n).toBeGreaterThan(0n);
    }
  });

  it('counts only what the treasury spent towards the ceiling', async () => {
    const { depositAccount } = await insertSettleablePayment(1501);
    await mintTo(depositAccount, 25_000_000n);
    await settleFully(settler);

    const spends = await repository.treasurySpends(NETWORK, broadcaster.treasuryAccount);
    // The gas drip only. The sweep is signed by the deposit address and is paid for out of it.
    expect(spends).toHaveLength(1);
  });
});

/**
 * The sequence allocator, and the hole that stalls an account.
 *
 * A number claimed and then not used is not a harmless gap: every later transaction from that
 * account queues behind the missing one indefinitely, so the treasury stops being able to fund
 * anything and settlement on the network stops with it. The engine therefore hands a number back
 * whenever it can prove nothing was sent with it.
 */
describe('sequence numbers that were claimed but never used', () => {
  it('hands the number back so the next claim reuses it', async () => {
    const claimed = await repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0);
    await repository.releaseSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, claimed);

    const reclaimed = await repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0);
    expect(reclaimed).toBe(claimed);
  });

  it('refuses to hand back a number another claim has already moved past', async () => {
    const first = await repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0);
    const second = await repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0);
    await repository.releaseSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, first);

    // The release did nothing, so the next claim continues after the second rather than colliding.
    const next = await repository.claimSequenceNumber(NETWORK, ALLOCATOR_PROBE_ACCOUNT, 0);
    expect(next).toBe(second + 1);
  });
});
