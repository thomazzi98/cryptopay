import { createHash, randomBytes } from 'node:crypto';

import type { Environment } from '@cryptopay/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * Two-phase idempotency for unsafe requests.
 *
 * A single-phase design — look for a stored response, and create one if absent — read-then-writes on
 * an endpoint that creates money. Two simultaneous requests both find nothing, both allocate a
 * payment address, and only the second collides on the primary key, by which point an address has
 * been issued and a sequence consumed for a payment that will never exist.
 *
 * Reserving first closes that window. The reservation is inserted before the use case runs, so a
 * concurrent duplicate is told to retry rather than being allowed to proceed in parallel. The stored
 * response is written in the same transaction as the payment it describes, so it is impossible to
 * have one without the other.
 *
 * A reservation carries a lock expiry rather than living forever. A process that dies mid-request
 * would otherwise block that key permanently, and the caller retrying is exactly the case
 * idempotency exists to serve.
 */

export type ReservationOutcome =
  /**
   * The token proves which attempt holds the reservation. A request whose lock expired while it was
   * still working loses it to a retry, and finds out when its response write matches no row.
   */
  | { readonly kind: 'reserved'; readonly ownerToken: string }
  | { readonly kind: 'replay'; readonly status: number; readonly body: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'fingerprint_mismatch' };

export interface ReservationRequest {
  readonly merchantId: string;
  /**
   * Part of the key, not a filter. A merchant holds a test key and a live key, and their own order
   * number is the obvious idempotency key, so without this the two environments collide on a value
   * the caller cannot see and cannot avoid.
   */
  readonly environment: Environment;
  readonly idempotencyKey: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

interface ReservationRow {
  readonly state: 'in_progress' | 'completed';
  readonly request_fingerprint: Buffer;
  readonly response_status: number | null;
  readonly response_body: string | null;
  readonly lock_expired: boolean;
  readonly lock_remaining_seconds: number;
}

/**
 * Long enough to cover a payment creation that has to derive an address and write two tables under
 * load. The old fifteen seconds was routinely shorter than the request it was protecting, so a
 * retry could take the lock while the original was still running. The owner token is what makes
 * that safe; this only makes it rare.
 */
const LOCK_SECONDS = 60;
const RETENTION_HOURS = 24;

/**
 * The fingerprint covers the method, the path and the exact body bytes. Reusing a key with a
 * different payload is a caller bug, and answering it with the first request's response would be
 * worse than an error: the caller would believe the second payment exists.
 */
export function fingerprintRequest(method: string, path: string, body: string): Buffer {
  return createHash('sha256').update(`${method}\n${path}\n${body}`, 'utf8').digest();
}

export class IdempotencyRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async reserve(request: ReservationRequest): Promise<ReservationOutcome> {
    const fingerprint = fingerprintRequest(request.method, request.path, request.body);
    const ownerToken = randomBytes(16).toString('hex');

    // A single statement does the whole decision. ON CONFLICT DO UPDATE claims an abandoned
    // reservation whose lock has expired, and its WHERE clause is what stops it claiming a live one.
    const claimed = await this.pool.query<{ claimed: boolean }>(
      `INSERT INTO idempotency_keys
         (merchant_id, environment, idempotency_key, request_method, request_path,
          request_fingerprint, state, lock_expires_at, expires_at, owner_token)
       VALUES ($1, $8::environment_name, $2, $3, $4, $5, 'in_progress',
               now() + make_interval(secs => $6), now() + make_interval(hours => $7), $9)
       ON CONFLICT (merchant_id, environment, idempotency_key) DO UPDATE
         SET lock_expires_at = now() + make_interval(secs => $6),
             request_fingerprint = EXCLUDED.request_fingerprint,
             owner_token = EXCLUDED.owner_token
         WHERE idempotency_keys.state = 'in_progress'
           AND idempotency_keys.lock_expires_at <= now()
           AND idempotency_keys.request_fingerprint = EXCLUDED.request_fingerprint
       RETURNING true AS claimed`,
      [
        request.merchantId,
        request.idempotencyKey,
        request.method,
        request.path,
        fingerprint,
        LOCK_SECONDS,
        RETENTION_HOURS,
        request.environment,
        ownerToken,
      ],
    );

    if (claimed.rows.length > 0) {
      return { kind: 'reserved', ownerToken };
    }

    const existing = await this.pool.query<ReservationRow>(
      `SELECT state, request_fingerprint, response_status, response_body,
              lock_expires_at <= now() AS lock_expired,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lock_expires_at - now()))))::int
                AS lock_remaining_seconds
         FROM idempotency_keys
        WHERE merchant_id = $1 AND environment = $3::environment_name AND idempotency_key = $2`,
      [request.merchantId, request.idempotencyKey, request.environment],
    );

    const row = existing.rows[0];
    if (row === undefined) {
      // The row vanished between the two statements, which means retention pruned it. Treating this
      // as retryable is safe: the caller repeats and reserves cleanly.
      return { kind: 'in_progress', retryAfterSeconds: 1 };
    }

    if (!row.request_fingerprint.equals(fingerprint)) {
      return { kind: 'fingerprint_mismatch' };
    }
    if (row.state === 'completed' && row.response_status !== null && row.response_body !== null) {
      return { kind: 'replay', status: row.response_status, body: row.response_body };
    }
    return { kind: 'in_progress', retryAfterSeconds: row.lock_remaining_seconds };
  }

  /**
   * Records the response. The caller passes the transaction that created the resource, so the
   * response snapshot and the payment commit together or not at all.
   */
  async complete(
    client: PoolClient,
    merchantId: string,
    environment: Environment,
    idempotencyKey: string,
    ownerToken: string,
    status: number,
    body: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = $4, response_body = $5
        WHERE merchant_id = $1 AND environment = $6::environment_name
          AND idempotency_key = $2 AND owner_token = $3`,
      [merchantId, idempotencyKey, ownerToken, status, body, environment],
    );
    return result.rowCount === 1;
  }

  /**
   * Drops a reservation whose request failed, so the caller can retry at once rather than waiting
   * for the lock to expire. A failed request must not make a key unusable.
   */
  async abandon(
    merchantId: string,
    environment: Environment,
    idempotencyKey: string,
    ownerToken: string,
  ): Promise<void> {
    await this.pool.query(
      // Only the holder may abandon. A request that already lost its lock must not delete the
      // reservation the winner is working under.
      `DELETE FROM idempotency_keys
        WHERE merchant_id = $1 AND environment = $4::environment_name
          AND idempotency_key = $2 AND owner_token = $3 AND state = 'in_progress'`,
      [merchantId, idempotencyKey, ownerToken, environment],
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }
}
