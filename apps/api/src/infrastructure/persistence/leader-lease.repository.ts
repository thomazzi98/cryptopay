import type { Pool } from 'pg';

/**
 * Singleton election for the loops that must run on exactly one process: block scanning,
 * confirmation, expiry, settlement and callback delivery.
 *
 * A session-level advisory lock would be simpler and is wrong here. It has no failover when a
 * process hangs while staying connected: the lock is held, scanning silently stops, and readiness
 * stays green because the process is technically alive. A lease expires whether or not its holder
 * notices, so the work moves.
 *
 * The `fencingToken` is what makes recovery safe rather than merely possible. It increases on every
 * acquisition, and every write a loop performs carries it as a predicate. A worker that stalls past
 * its lease, has the work taken over, then wakes up and completes its operation writes zero rows
 * instead of clobbering the new holder.
 */

export interface Lease {
  readonly leaseName: string;
  readonly holderIdentity: string;
  readonly fencingToken: bigint;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

interface LeaseRow {
  readonly lease_name: string;
  readonly holder_identity: string;
  readonly fencing_token: string;
  readonly acquired_at: Date;
  readonly expires_at: Date;
}

function toLease(row: LeaseRow): Lease {
  return Object.freeze({
    leaseName: row.lease_name,
    holderIdentity: row.holder_identity,
    // A bigint token would lose precision as a JavaScript number, so the driver returns it as text.
    fencingToken: BigInt(row.fencing_token),
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  });
}

export class LeaderLeaseRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Takes the lease if it is unheld or expired, or extends it if this holder already has it.
   * Returns null when another process holds a live lease, which is the normal outcome for every
   * instance but one and is not an error.
   */
  async acquire(
    leaseName: string,
    holderIdentity: string,
    durationSeconds: number,
  ): Promise<Lease | null> {
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO leader_leases (lease_name, holder_identity, fencing_token, acquired_at, expires_at)
       VALUES ($1, $2, 1, now(), now() + make_interval(secs => $3))
       ON CONFLICT (lease_name) DO UPDATE
         SET holder_identity = EXCLUDED.holder_identity,
             fencing_token   = leader_leases.fencing_token + 1,
             acquired_at     = now(),
             expires_at      = EXCLUDED.expires_at
         WHERE leader_leases.expires_at <= now()
            OR leader_leases.holder_identity = EXCLUDED.holder_identity
       RETURNING lease_name, holder_identity, fencing_token, acquired_at, expires_at`,
      [leaseName, holderIdentity, durationSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toLease(row);
  }

  /**
   * Extends a lease this process still holds, keeping the same fencing token. Returns null if the
   * lease was lost, in which case the caller must stop working immediately rather than finishing
   * the tick: its token is now stale and its writes would be rejected anyway.
   */
  async renew(lease: Lease, durationSeconds: number): Promise<Lease | null> {
    const result = await this.pool.query<LeaseRow>(
      `UPDATE leader_leases
          SET expires_at = now() + make_interval(secs => $4)
        WHERE lease_name = $1
          AND holder_identity = $2
          AND fencing_token = $3
          AND expires_at > now()
       RETURNING lease_name, holder_identity, fencing_token, acquired_at, expires_at`,
      [lease.leaseName, lease.holderIdentity, lease.fencingToken.toString(), durationSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toLease(row);
  }

  /** Hands the lease back on a clean shutdown so a peer takes over at once rather than after expiry. */
  async release(lease: Lease): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM leader_leases
        WHERE lease_name = $1 AND holder_identity = $2 AND fencing_token = $3`,
      [lease.leaseName, lease.holderIdentity, lease.fencingToken.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async readCurrent(leaseName: string): Promise<Lease | null> {
    const result = await this.pool.query<LeaseRow>(
      `SELECT lease_name, holder_identity, fencing_token, acquired_at, expires_at
         FROM leader_leases WHERE lease_name = $1`,
      [leaseName],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toLease(row);
  }
}
