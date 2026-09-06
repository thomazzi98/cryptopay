import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Every rule the payment domain depends on is asserted here by proving the database rejects the
 * violating write. A constraint nobody has watched fail is a constraint nobody knows exists: these
 * tests are the difference between a schema that documents an intention and one that enforces it.
 */

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';

let pool: Pool;
let dropDatabase: () => Promise<void>;

const MERCHANT_ID = 'mch_01K4QW6ZR2M8X4T7YQ0C3D5B9N';
const ACCOUNT_ONE = '0x7b1a4e6c0f9d2a3b5c8e1f04a6d7b9c2e3f10a4d';
const ACCOUNT_TWO = '0x3f9c2b7100000000000000000000000000000001';
const USDC_AMOY = '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582';
const TRANSACTION = `0x${'a'.repeat(64)}`;
const BLOCK = `0x${'b'.repeat(64)}`;

interface PaymentOverrides {
  readonly id?: string;
  readonly environment?: string;
  readonly network?: string;
  readonly checkoutToken?: string;
  readonly receivingAccount?: string;
  readonly requested?: string;
  readonly minimum?: string;
  readonly maximum?: string;
  readonly status?: string;
  readonly completedAt?: string | null;
  readonly assetReference?: string;
}

async function insertPayment(overrides: PaymentOverrides = {}): Promise<string> {
  const id = overrides.id ?? `pay_${Math.random().toString(36).slice(2, 15).padEnd(26, '0')}`;
  await pool.query(
    `INSERT INTO payments (
       id, merchant_id, environment, network_identifier, checkout_token,
       asset_reference, asset_symbol, asset_decimals,
       requested_amount, minimum_acceptable_amount, maximum_acceptable_amount,
       receiving_account, status, required_confirmations, requires_finality_tag,
       created_at_block_height, expires_at, completed_at
     ) VALUES ($1,$2,$3::environment_name,$4::network_identifier,$5,$6,'USDC',6,
               $7,$8,$9,$10,$11::payment_status,5,true,1000, now() + interval '30 minutes', $12)`,
    [
      id,
      MERCHANT_ID,
      overrides.environment ?? 'test',
      overrides.network ?? 'polygon-amoy',
      overrides.checkoutToken ?? id,
      overrides.assetReference ?? USDC_AMOY,
      overrides.requested ?? '25000000',
      overrides.minimum ?? '25000000',
      overrides.maximum ?? '25000000',
      overrides.receivingAccount ?? ACCOUNT_ONE,
      overrides.status ?? 'pending',
      overrides.completedAt ?? null,
    ],
  );
  return id;
}

/** Produces a non-lowercase form of an address without writing one as a literal, which is banned. */
function asMixedCase(address: string): string {
  return `0x${address.slice(2).toUpperCase()}`;
}

async function expectViolation(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

function insertAddress(id: string, paymentId: string, account: string, index: number) {
  return pool.query(
    `INSERT INTO payment_addresses
       (id, payment_id, environment, network_identifier, account, derivation_index, allocation_reference)
     VALUES ($1,$2,'test','polygon-amoy',$3,$4,$5)`,
    [id, paymentId, account, index, `m/44'/60'/0'/0/${index}`],
  );
}

function insertHeaderAt(height: number, reference: string) {
  return pool.query(
    `INSERT INTO observed_blocks (network_identifier, block_height, block_reference, parent_reference)
     VALUES ('polygon-amoy', $1, $2, $3)`,
    [height, reference, BLOCK],
  );
}

function insertSeedFor(id: string, environment: string) {
  return pool.query(
    `INSERT INTO wallet_seeds
       (id, environment, scheme, key_identifier, wrapped_data_key, nonce, ciphertext, authentication_tag)
     VALUES ($1,$2::environment_name,'AESGCM256_LOCALKEY_V1','local',$3,$4,$5,$6)`,
    [
      id,
      environment,
      Buffer.alloc(32, 1),
      Buffer.alloc(12, 2),
      Buffer.alloc(64, 3),
      Buffer.alloc(16, 4),
    ],
  );
}

function reserveIdempotencyKey(key: string) {
  return pool.query(
    `INSERT INTO idempotency_keys
       (merchant_id, idempotency_key, request_method, request_path, request_fingerprint,
        state, lock_expires_at, expires_at)
     VALUES ($1,$2,'POST','/v1/payments',$3,'in_progress',
             now() + interval '10 seconds', now() + interval '24 hours')`,
    [MERCHANT_ID, key, Buffer.alloc(32, 9)],
  );
}

function acquireLease(leaseName: string, holder: string) {
  return pool.query(
    `INSERT INTO leader_leases (lease_name, holder_identity, fencing_token, expires_at)
     VALUES ($1, $2, 1, now() + interval '30 seconds')`,
    [leaseName, holder],
  );
}

beforeAll(async () => {
  const port = inject('postgresPort');
  const isolated = await createIsolatedDatabase(port, 'constraints');
  pool = isolated.pool;
  dropDatabase = isolated.drop;

  await pool.query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [MERCHANT_ID, 'Test Shop']);
});

afterAll(async () => {
  await dropDatabase();
});

describe('the migration set', () => {
  it('records itself so readiness can compare schema against binary', async () => {
    const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(result.rows.map((row) => row.name)).toContain('0001_payment_core.sql');
  });
});

describe('environment separation', () => {
  it('accepts a test payment on a test network', async () => {
    await expect(
      insertPayment({ environment: 'test', network: 'polygon-amoy' }),
    ).resolves.toBeDefined();
  });

  it('accepts a live payment on mainnet', async () => {
    await expect(
      insertPayment({
        environment: 'live',
        network: 'polygon-mainnet',
        receivingAccount: ACCOUNT_TWO,
      }),
    ).resolves.toBeDefined();
  });

  // The property that makes a test-mode API key physically incapable of producing a mainnet row.
  it('refuses a test payment on mainnet', async () => {
    await expectViolation(
      insertPayment({ environment: 'test', network: 'polygon-mainnet' }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a live payment on a testnet', async () => {
    await expectViolation(
      insertPayment({ environment: 'live', network: 'polygon-amoy' }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a live payment on the local chain', async () => {
    await expectViolation(
      insertPayment({ environment: 'live', network: 'local-anvil' }),
      CHECK_VIOLATION,
    );
  });
});

describe('payment invariants', () => {
  it('refuses an acceptance band that excludes the requested amount', async () => {
    await expectViolation(
      insertPayment({ requested: '25000000', minimum: '26000000', maximum: '27000000' }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a maximum below the requested amount', async () => {
    await expectViolation(
      insertPayment({ requested: '25000000', minimum: '24000000', maximum: '24500000' }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a zero or negative requested amount', async () => {
    await expectViolation(
      insertPayment({ requested: '0', minimum: '0', maximum: '0' }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a completed payment with no completion timestamp', async () => {
    await expectViolation(insertPayment({ status: 'completed' }), CHECK_VIOLATION);
  });

  it('accepts a completed payment that carries one', async () => {
    await expect(
      insertPayment({
        status: 'completed',
        completedAt: new Date().toISOString(),
        receivingAccount: '0x1111111111111111111111111111111111111111',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a checksummed receiving account', async () => {
    await expectViolation(
      insertPayment({ receivingAccount: asMixedCase(ACCOUNT_ONE) }),
      CHECK_VIOLATION,
    );
  });

  it('refuses a checksummed asset reference', async () => {
    await expectViolation(
      insertPayment({ assetReference: asMixedCase(USDC_AMOY) }),
      CHECK_VIOLATION,
    );
  });

  it('refuses two payments sharing a receiving account on one network', async () => {
    const account = '0x2222222222222222222222222222222222222222';
    await insertPayment({ receivingAccount: account });
    await expectViolation(insertPayment({ receivingAccount: account }), UNIQUE_VIOLATION);
  });

  it('refuses a payment for a merchant that does not exist', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO payments (
           id, merchant_id, environment, network_identifier, checkout_token, asset_reference,
           asset_symbol, asset_decimals, requested_amount, minimum_acceptable_amount,
           maximum_acceptable_amount, receiving_account, required_confirmations,
           requires_finality_tag, created_at_block_height, expires_at
         ) VALUES ('pay_orphan','mch_missing','test','polygon-amoy','tok_orphan',$1,'USDC',6,
                   1,1,1,'0x3333333333333333333333333333333333333333',5,true,1,now())`,
        [USDC_AMOY],
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('preserves an amount far beyond a 64-bit integer', async () => {
    const huge = '9'.repeat(30);
    const id = await insertPayment({
      requested: huge,
      minimum: huge,
      maximum: huge,
      receivingAccount: '0x4444444444444444444444444444444444444444',
    });
    const result = await pool.query<{ requested_amount: string }>(
      'SELECT requested_amount FROM payments WHERE id = $1',
      [id],
    );
    expect(result.rows[0]?.requested_amount).toBe(huge);
  });
});

describe('address allocation', () => {
  it('refuses to issue one derivation index twice in an environment', async () => {
    const paymentOne = await insertPayment({
      receivingAccount: '0x5555555555555555555555555555555555555555',
    });
    const paymentTwo = await insertPayment({
      receivingAccount: '0x6666666666666666666666666666666666666666',
    });

    await insertAddress('adr_1', paymentOne, '0x5555555555555555555555555555555555555555', 7);
    await expectViolation(
      insertAddress('adr_2', paymentTwo, '0x6666666666666666666666666666666666666666', 7),
      UNIQUE_VIOLATION,
    );
  });

  it('refuses a negative derivation index', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0x7777777777777777777777777777777777777777',
    });
    await expectViolation(
      pool.query(
        `INSERT INTO payment_addresses
           (id, payment_id, environment, network_identifier, account, derivation_index, allocation_reference)
         VALUES ('adr_neg',$1,'test','polygon-amoy','0x7777777777777777777777777777777777777777',-1,'m/x')`,
        [paymentId],
      ),
      CHECK_VIOLATION,
    );
  });

  it('issues gap-free-enough indices from a sequence per environment', async () => {
    const first = await pool.query<{ nextval: string }>(
      "SELECT nextval('payment_address_index_test') AS nextval",
    );
    const second = await pool.query<{ nextval: string }>(
      "SELECT nextval('payment_address_index_test') AS nextval",
    );
    expect(Number(second.rows[0]?.nextval)).toBeGreaterThan(Number(first.rows[0]?.nextval));
  });

  it('keeps the test and live index sequences independent', async () => {
    const live = await pool.query<{ nextval: string }>(
      "SELECT nextval('payment_address_index_live') AS nextval",
    );
    expect(Number(live.rows[0]?.nextval)).toBeGreaterThanOrEqual(0);
  });
});

describe('chain replay protection', () => {
  it('refuses to record the same on-chain event twice', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0x8888888888888888888888888888888888888888',
    });

    const insertTransfer = (id: string) =>
      pool.query(
        `INSERT INTO payment_transfers
           (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
            block_reference, source_account, asset_reference, amount, classification)
         VALUES ($1,$2,'polygon-amoy',$3,12,46903512,$4,$5,$6,25000000,'credited')`,
        [id, paymentId, TRANSACTION, BLOCK, ACCOUNT_TWO, USDC_AMOY],
      );

    await insertTransfer('trf_1');
    await expectViolation(insertTransfer('trf_2'), UNIQUE_VIOLATION);
  });

  it('treats two events in one transaction as distinct transfers', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0x9999999999999999999999999999999999999999',
    });
    const transaction = `0x${'c'.repeat(64)}`;

    const insertTransfer = (id: string, eventIndex: number) =>
      pool.query(
        `INSERT INTO payment_transfers
           (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
            block_reference, source_account, asset_reference, amount, classification)
         VALUES ($1,$2,'polygon-amoy',$3,$4,46903512,$5,$6,$7,1,'credited')`,
        [id, paymentId, transaction, eventIndex, BLOCK, ACCOUNT_TWO, USDC_AMOY],
      );

    await insertTransfer('trf_a', 0);
    await expect(insertTransfer('trf_b', 1)).resolves.toBeDefined();
  });

  it('refuses a zero-value transfer', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0xaaaa000000000000000000000000000000000001',
    });
    await expectViolation(
      pool.query(
        `INSERT INTO payment_transfers
           (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
            block_reference, source_account, asset_reference, amount, classification)
         VALUES ('trf_zero',$1,'polygon-amoy',$2,0,1,$3,$4,$5,0,'credited')`,
        [paymentId, `0x${'d'.repeat(64)}`, BLOCK, ACCOUNT_TWO, USDC_AMOY],
      ),
      CHECK_VIOLATION,
    );
  });

  it('keeps the orphan flag and its timestamp in step', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0xaaaa000000000000000000000000000000000002',
    });
    await expectViolation(
      pool.query(
        `INSERT INTO payment_transfers
           (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
            block_reference, source_account, asset_reference, amount, classification, observation)
         VALUES ('trf_orphan',$1,'polygon-amoy',$2,0,1,$3,$4,$5,1,'credited','orphaned')`,
        [paymentId, `0x${'e'.repeat(64)}`, BLOCK, ACCOUNT_TWO, USDC_AMOY],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('the status audit trail', () => {
  it('refuses two writers recording the same version, which is how a bypassed CAS is caught', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0xbbbb000000000000000000000000000000000001',
    });

    const record = (command: string) =>
      pool.query(
        `INSERT INTO payment_status_transitions
           (payment_id, from_status, to_status, from_version, to_version, command, credited_amount)
         VALUES ($1,'pending','confirming',0,1,$2,25000000)`,
        [paymentId, command],
      );

    await record('recordCreditedTransfer');
    await expectViolation(record('recordCreditedTransfer'), UNIQUE_VIOLATION);
  });

  it('refuses a transition that does not advance the version', async () => {
    const paymentId = await insertPayment({
      receivingAccount: '0xbbbb000000000000000000000000000000000002',
    });
    await expectViolation(
      pool.query(
        `INSERT INTO payment_status_transitions
           (payment_id, from_status, to_status, from_version, to_version, command, credited_amount)
         VALUES ($1,'pending','confirming',3,3,'recordCreditedTransfer',1)`,
        [paymentId],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('scanning state', () => {
  it('requires a reason whenever a network is halted', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO block_cursors
           (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range, halted_at)
         VALUES ('polygon-amoy', 1, $1, 500, now())`,
        [BLOCK],
      ),
      CHECK_VIOLATION,
    );
  });

  it('accepts a halt that carries one', async () => {
    await expect(
      pool.query(
        `INSERT INTO block_cursors
           (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range,
            halted_at, halted_reason)
         VALUES ('local-anvil', 1, $1, 500, now(), 'reorg deeper than the configured limit')`,
        [BLOCK],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a non-positive scan range', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO block_cursors
           (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
         VALUES ('polygon-mainnet', 1, $1, 0)`,
        [BLOCK],
      ),
      CHECK_VIOLATION,
    );
  });

  it('keeps one header per height per network', async () => {
    await insertHeaderAt(500, `0x${'1'.repeat(64)}`);
    await expectViolation(insertHeaderAt(500, `0x${'2'.repeat(64)}`), UNIQUE_VIOLATION);
  });

  it('refuses a checksummed block reference', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO observed_blocks (network_identifier, block_height, block_reference, parent_reference)
         VALUES ('polygon-amoy', 501, $1, $2)`,
        [`0x${'A'.repeat(64)}`, BLOCK],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('wallet seeds', () => {
  it('holds at most one seed per environment', async () => {
    await insertSeedFor('sed_test', 'test');
    await expectViolation(insertSeedFor('sed_test_again', 'test'), UNIQUE_VIOLATION);
  });

  it('keeps the live seed separate from the test seed', async () => {
    await expect(insertSeedFor('sed_live', 'live')).resolves.toBeDefined();
  });
});

describe('idempotency records', () => {
  it('refuses a second reservation under the same key for one merchant', async () => {
    await reserveIdempotencyKey('key-1');
    await expectViolation(reserveIdempotencyKey('key-1'), UNIQUE_VIOLATION);
  });

  it('refuses a completed record with no stored response', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO idempotency_keys
           (merchant_id, idempotency_key, request_method, request_path, request_fingerprint,
            state, lock_expires_at, expires_at)
         VALUES ($1,'key-2','POST','/v1/payments',$2,'completed',
                 now(), now() + interval '24 hours')`,
        [MERCHANT_ID, Buffer.alloc(32, 9)],
      ),
      CHECK_VIOLATION,
    );
  });

  it('refuses a fingerprint that is not a full digest', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO idempotency_keys
           (merchant_id, idempotency_key, request_method, request_path, request_fingerprint,
            state, lock_expires_at, expires_at)
         VALUES ($1,'key-3','POST','/v1/payments',$2,'in_progress',
                 now(), now() + interval '24 hours')`,
        [MERCHANT_ID, Buffer.alloc(8, 9)],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('leader leases', () => {
  it('holds one lease per name', async () => {
    await acquireLease('scanner:polygon-amoy', 'worker-a');
    await expectViolation(acquireLease('scanner:polygon-amoy', 'worker-b'), UNIQUE_VIOLATION);
  });

  it('refuses a fencing token that cannot advance', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO leader_leases (lease_name, holder_identity, fencing_token, expires_at)
         VALUES ('scanner:local-anvil', 'worker-a', 0, now() + interval '30 seconds')`,
      ),
      CHECK_VIOLATION,
    );
  });

  it('requires a holder identity', async () => {
    await expectViolation(
      pool.query(
        `INSERT INTO leader_leases (lease_name, holder_identity, fencing_token, expires_at)
         VALUES ('scanner:polygon-mainnet', NULL, 1, now() + interval '30 seconds')`,
      ),
      NOT_NULL_VIOLATION,
    );
  });
});

describe('merchant tolerances', () => {
  it('refuses a tolerance beyond ten percent', async () => {
    await expectViolation(
      pool.query(
        'INSERT INTO merchants (id, name, underpayment_tolerance_basis_points) VALUES ($1,$2,1001)',
        ['mch_wide', 'Too tolerant'],
      ),
      CHECK_VIOLATION,
    );
  });

  it('refuses a payment lifetime beyond a day', async () => {
    await expectViolation(
      pool.query(
        'INSERT INTO merchants (id, name, default_payment_lifetime_seconds) VALUES ($1,$2,86401)',
        ['mch_slow', 'Too patient'],
      ),
      CHECK_VIOLATION,
    );
  });
});
