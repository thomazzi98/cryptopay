import { createHash } from 'node:crypto';

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
  | { readonly kind: 'reserved' }
  | { readonly kind: 'replay'; readonly status: number; readonly body: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'fingerprint_mismatch' };

export interface ReservationRequest {
  readonly merchantId: string;
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

const LOCK_SECONDS = 15;
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

    // A single statement does the whole decision. ON CONFLICT DO UPDATE claims an abandoned
    // reservation whose lock has expired, and its WHERE clause is what stops it claiming a live one.
    const claimed = await this.pool.query<{ claimed: boolean }>(
      `INSERT INTO idempotency_keys
         (merchant_id, idempotency_key, request_method, request_path, request_fingerprint,
          state, lock_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress',
               now() + make_interval(secs => $6), now() + make_interval(hours => $7))
       ON CONFLICT (merchant_id, idempotency_key) DO UPDATE
         SET lock_expires_at = now() + make_interval(secs => $6),
             request_fingerprint = EXCLUDED.request_fingerprint
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
      ],
    );

    if (claimed.rows.length > 0) {
      return { kind: 'reserved' };
    }

    const existing = await this.pool.query<ReservationRow>(
      `SELECT state, request_fingerprint, response_status, response_body,
              lock_expires_at <= now() AS lock_expired,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM (lock_expires_at - now()))))::int
                AS lock_remaining_seconds
         FROM idempotency_keys
        WHERE merchant_id = $1 AND idempotency_key = $2`,
      [request.merchantId, request.idempotencyKey],
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
    idempotencyKey: string,
    status: number,
    body: string,
  ): Promise<void> {
    await client.query(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = $3, response_body = $4
        WHERE merchant_id = $1 AND idempotency_key = $2`,
      [merchantId, idempotencyKey, status, body],
    );
  }

  /**
   * Drops a reservation whose request failed, so the caller can retry at once rather than waiting
   * for the lock to expire. A failed request must not make a key unusable.
   */
  async abandon(merchantId: string, idempotencyKey: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys
        WHERE merchant_id = $1 AND idempotency_key = $2 AND state = 'in_progress'`,
      [merchantId, idempotencyKey],
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }
}
