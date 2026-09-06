import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  LeaderLeaseRepository,
  type Lease,
} from '../src/infrastructure/persistence/leader-lease.repository.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

/**
 * Leadership is the mechanism that keeps exactly one scanner running per network. These tests drive
 * the failure paths that matter: a peer taking over after a holder stops renewing, and a stalled
 * holder waking up to find its writes rejected.
 */

let pool: Pool;
let dropDatabase: () => Promise<void>;
let repository: LeaderLeaseRepository;

const LEASE = 'scanner:polygon-amoy';
const SHORT_LEASE_SECONDS = 1;
const NORMAL_LEASE_SECONDS = 30;

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'leases');
  pool = isolated.pool;
  dropDatabase = isolated.drop;
  repository = new LeaderLeaseRepository(pool);
});

afterAll(async () => {
  await dropDatabase();
});

beforeEach(async () => {
  await pool.query('DELETE FROM leader_leases');
});

async function expireLease(leaseName: string): Promise<void> {
  await pool.query(
    "UPDATE leader_leases SET expires_at = now() - interval '1 second' WHERE lease_name = $1",
    [leaseName],
  );
}

describe('acquiring a lease', () => {
  it('grants the lease to the first caller', async () => {
    const lease = await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS);
    expect(lease?.holderIdentity).toBe('worker-a');
    expect(lease?.fencingToken).toBe(1n);
  });

  it('refuses a second holder while the lease is live', async () => {
    await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS);
    expect(await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS)).toBeNull();
  });

  it('grants exactly one holder when many contend at once', async () => {
    const contenders = Array.from({ length: 12 }, (value, index) => `worker-${index}`);
    const outcomes = await Promise.all(
      contenders.map((identity) => repository.acquire(LEASE, identity, NORMAL_LEASE_SECONDS)),
    );

    const winners = outcomes.filter((lease): lease is Lease => lease !== null);
    expect(winners).toHaveLength(1);

    const current = await repository.readCurrent(LEASE);
    expect(current?.holderIdentity).toBe(winners[0]?.holderIdentity);
  });

  it('lets the same holder extend without changing hands', async () => {
    const first = await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS);
    const second = await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS);
    expect(second?.holderIdentity).toBe('worker-a');
    expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken ?? 0n);
  });

  it('keeps leases for different names independent', async () => {
    await repository.acquire('scanner:polygon-amoy', 'worker-a', NORMAL_LEASE_SECONDS);
    const other = await repository.acquire(
      'settlement:polygon-amoy',
      'worker-b',
      NORMAL_LEASE_SECONDS,
    );
    expect(other?.holderIdentity).toBe('worker-b');
  });
});

describe('failover', () => {
  // The case a session advisory lock cannot handle: the holder is still connected but has stopped
  // doing the work, so nothing releases the lock and scanning halts with readiness green.
  it('hands the lease to a peer once it expires', async () => {
    await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS);
    await expireLease(LEASE);

    const successor = await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS);
    expect(successor?.holderIdentity).toBe('worker-b');
  });

  it('advances the fencing token on every handover', async () => {
    const first = await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS);
    await expireLease(LEASE);
    const second = await repository.acquire(LEASE, 'worker-b', SHORT_LEASE_SECONDS);
    await expireLease(LEASE);
    const third = await repository.acquire(LEASE, 'worker-c', NORMAL_LEASE_SECONDS);

    expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken ?? 0n);
    expect(third?.fencingToken).toBeGreaterThan(second?.fencingToken ?? 0n);
  });

  it('releases immediately on a clean shutdown so a peer need not wait for expiry', async () => {
    const lease = await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS);
    expect(await repository.release(lease as Lease)).toBe(true);

    const successor = await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS);
    expect(successor?.holderIdentity).toBe('worker-b');
    expect(successor?.fencingToken).toBe(1n);
  });

  it('ignores a release from a holder that no longer owns the lease', async () => {
    const stale = await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS);
    await expireLease(LEASE);
    await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS);

    expect(await repository.release(stale as Lease)).toBe(false);
    const current = await repository.readCurrent(LEASE);
    expect(current?.holderIdentity).toBe('worker-b');
  });
});

describe('renewal', () => {
  it('extends the lease and keeps the same fencing token', async () => {
    const lease = (await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS)) as Lease;
    const renewed = await repository.renew(lease, NORMAL_LEASE_SECONDS);

    expect(renewed?.fencingToken).toBe(lease.fencingToken);
    expect(renewed?.expiresAt.getTime()).toBeGreaterThanOrEqual(lease.expiresAt.getTime());
  });

  // A worker whose renewal fails must stop the tick rather than finish it: its token is stale and
  // every write it attempts would be rejected anyway.
  it('reports loss when a peer has taken over', async () => {
    const lease = (await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS)) as Lease;
    await expireLease(LEASE);
    await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS);

    expect(await repository.renew(lease, NORMAL_LEASE_SECONDS)).toBeNull();
  });

  it('reports loss when the lease has already expired', async () => {
    const lease = (await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS)) as Lease;
    await expireLease(LEASE);
    expect(await repository.renew(lease, NORMAL_LEASE_SECONDS)).toBeNull();
  });

  it('reports loss when the lease was deleted', async () => {
    const lease = (await repository.acquire(LEASE, 'worker-a', NORMAL_LEASE_SECONDS)) as Lease;
    await pool.query('DELETE FROM leader_leases WHERE lease_name = $1', [LEASE]);
    expect(await repository.renew(lease, NORMAL_LEASE_SECONDS)).toBeNull();
  });
});

describe('fencing', () => {
  /**
   * The property that makes takeover safe. A stalled worker that wakes up after its lease moved
   * must affect zero rows, not clobber the new holder's progress.
   */
  it('rejects a write carrying a stale fencing token', async () => {
    const stale = (await repository.acquire(LEASE, 'worker-a', SHORT_LEASE_SECONDS)) as Lease;
    await expireLease(LEASE);
    const current = (await repository.acquire(LEASE, 'worker-b', NORMAL_LEASE_SECONDS)) as Lease;

    await pool.query(
      `INSERT INTO block_cursors
         (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range, fencing_token)
       VALUES ('polygon-amoy', 100, $1, 500, $2)`,
      [`0x${'a'.repeat(64)}`, current.fencingToken.toString()],
    );

    const staleWrite = await pool.query(
      `UPDATE block_cursors SET last_scanned_height = 999
        WHERE network_identifier = 'polygon-amoy' AND fencing_token = $1`,
      [stale.fencingToken.toString()],
    );
    expect(staleWrite.rowCount).toBe(0);

    const currentWrite = await pool.query(
      `UPDATE block_cursors SET last_scanned_height = 200
        WHERE network_identifier = 'polygon-amoy' AND fencing_token = $1`,
      [current.fencingToken.toString()],
    );
    expect(currentWrite.rowCount).toBe(1);

    const cursor = await pool.query<{ last_scanned_height: string }>(
      "SELECT last_scanned_height FROM block_cursors WHERE network_identifier = 'polygon-amoy'",
    );
    expect(cursor.rows[0]?.last_scanned_height).toBe('200');
  });

  it('never reuses a token after a handover', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 5; round += 1) {
      const lease = await repository.acquire(LEASE, `worker-${round}`, SHORT_LEASE_SECONDS);
      expect(seen.has(lease?.fencingToken.toString() ?? '')).toBe(false);
      seen.add(lease?.fencingToken.toString() ?? '');
      await expireLease(LEASE);
    }
    expect(seen.size).toBe(5);
  });
});
