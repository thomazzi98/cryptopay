import type { Environment } from '@cryptopay/shared';
import type { Pool } from 'pg';

import type { AttemptOutcome } from '../../domain/webhook-retry.js';

/**
 * The callback outbox.
 *
 * A delivery row is written in the same transaction as the payment status change that caused it, so
 * a completed payment with nobody told about it is not a state the database can hold. That is the
 * whole reason this is a table rather than a queue in another system: committing here and enqueuing
 * there is a dual write, and the window between them is exactly long enough for a process to die.
 */

type DeliveryStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'abandoned';

export interface WebhookDelivery {
  readonly identifier: string;
  readonly merchantId: string;
  readonly paymentId: string;
  readonly environment: Environment;
  readonly eventType: string;
  readonly destinationUrl: string;
  /** Serialized at enqueue and transmitted byte for byte, because the signature covers these bytes. */
  readonly payload: string;
  readonly status: DeliveryStatus;
  /**
   * Every attempt ever made for this event, across redeliveries. It only ever rises, which is what
   * keeps attempt numbers unique and the history complete.
   */
  readonly attemptCount: number;
  /**
   * The attempt count when the current cycle began. The retry policy counts from here, so a
   * redelivery gets the whole schedule again while the history keeps its earlier attempts.
   */
  readonly scheduleOffset: number;
  /** When the current cycle began. The age ceiling is measured from this, not from createdAt. */
  readonly cycleStartedAt: Date;
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly lastFailure: string | null;
  readonly createdAt: Date;
}

interface DeliveryRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly payment_id: string;
  readonly environment: Environment;
  readonly event_type: string;
  readonly destination_url: string;
  readonly payload: string;
  readonly status: DeliveryStatus;
  readonly attempt_count: number;
  readonly schedule_offset: number;
  readonly cycle_started_at: Date;
  readonly next_attempt_at: Date;
  readonly delivered_at: Date | null;
  readonly last_failure: string | null;
  readonly created_at: Date;
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return Object.freeze({
    identifier: row.id,
    merchantId: row.merchant_id,
    paymentId: row.payment_id,
    environment: row.environment,
    eventType: row.event_type,
    destinationUrl: row.destination_url,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attempt_count,
    scheduleOffset: row.schedule_offset,
    cycleStartedAt: row.cycle_started_at,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    lastFailure: row.last_failure,
    createdAt: row.created_at,
  });
}

const DELIVERY_COLUMNS = `id, merchant_id, payment_id, environment, event_type, destination_url,
  payload, status, attempt_count, schedule_offset, cycle_started_at, next_attempt_at, delivered_at,
  last_failure, created_at`;

export interface RecordedAttempt {
  readonly deliveryId: string;
  /**
   * Who is writing this result. A worker whose lease expired while it was in flight has had its
   * delivery taken over by somebody else, and must not overwrite what the new holder recorded.
   */
  readonly claimedBy: string;
  readonly attemptNumber: number;
  readonly outcome: AttemptOutcome;
  readonly responseStatus: number | null;
  readonly resolvedAddress: string | null;
  readonly responseSnippet: string | null;
  readonly durationMilliseconds: number;
  readonly failureReason: string | null;
  readonly usedPrivateAllowlist: boolean;
}

/**
 * An attempt as it is read back, which is not the same shape as one being written. The claim is a
 * write-time authorisation and is deliberately absent here: nothing reading history needs to know
 * which worker held the lease, and publishing it would put an internal identity on a merchant's
 * screen.
 */
export interface DeliveryAttempt extends Omit<RecordedAttempt, 'claimedBy'> {
  readonly requestedAt: Date;
}

interface AttemptRow {
  readonly delivery_id: string;
  readonly attempt_number: number;
  readonly outcome: AttemptOutcome;
  readonly response_status: number | null;
  readonly resolved_address: string | null;
  readonly response_snippet: string | null;
  readonly duration_milliseconds: number;
  readonly failure_reason: string | null;
  readonly used_private_allowlist: boolean;
  readonly requested_at: Date;
}

export interface DeliveryListFilter {
  readonly merchantId: string;
  readonly environment: Environment;
  readonly status?: DeliveryStatus;
  readonly paymentId?: string;
  readonly limit: number;
  readonly startingAfter?: string;
}

export interface DeliveryPage {
  readonly deliveries: readonly WebhookDelivery[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export class WebhookDeliveryRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Takes the next deliveries that are due.
   *
   * Due-ness is judged by the database's clock rather than by the worker's. Both timestamps then
   * come from the same source, so a millisecond of skew between a worker and the database cannot make
   * a row that was just enqueued look like it belongs to the future.
   *
   * The claim is a lease rather than a status flag, so a worker that dies mid-flight releases its
   * work by expiry.
   *
   * At most one delivery per merchant environment is taken, which is what keeps a merchant's events
   * in order. The DISTINCT ON is what makes that true within one batch; the partial unique index on
   * (merchant_id, environment) WHERE status = 'in_flight' is what makes it true across concurrent
   * workers, and it is the database enforcing the invariant rather than the worker intending it.
   */
  async claimDue(
    workerIdentity: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly WebhookDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `WITH due AS (
         SELECT DISTINCT ON (candidate.merchant_id, candidate.environment)
                candidate.id, candidate.next_attempt_at
           FROM webhook_deliveries candidate
          WHERE candidate.status IN ('pending', 'failed')
            AND candidate.next_attempt_at <= now()
            AND NOT EXISTS (
              SELECT 1 FROM webhook_deliveries busy
               WHERE busy.merchant_id = candidate.merchant_id
                 AND busy.environment = candidate.environment
                 AND busy.status = 'in_flight'
            )
          ORDER BY candidate.merchant_id, candidate.environment, candidate.next_attempt_at,
                   candidate.id
       )
       UPDATE webhook_deliveries
          SET status = 'in_flight',
              claimed_by = $1,
              claim_expires_at = now() + make_interval(secs => $3),
              updated_at = now()
        WHERE id IN (SELECT id FROM due ORDER BY next_attempt_at, id LIMIT $2)
          -- Re-checked here, not only in the subquery. Two workers selecting concurrently see the
          -- same candidate rows; the second blocks on the row lock, and under READ COMMITTED
          -- PostgreSQL re-evaluates this predicate against the row the first one just wrote. Without
          -- it both workers claim the same delivery and the merchant receives the callback twice.
          -- The partial unique index does not catch this: both are writing the same row, so there is
          -- still only one in-flight delivery for that merchant environment.
          AND status IN ('pending', 'failed')
      RETURNING ${DELIVERY_COLUMNS}`,
      [workerIdentity, limit, leaseSeconds],
    );
    return result.rows.map((row) => toDelivery(row));
  }

  /**
   * Records the attempt and what happens next, in one transaction.
   *
   * The attempt row and the delivery's new state describe the same event. Writing them separately
   * would let a crash leave a delivery scheduled for a retry that no attempt row explains, and the
   * dashboard would show a countdown for a reason nobody can look up.
   */
  async completeAttempt(
    attempt: RecordedAttempt,
    next:
      | { readonly kind: 'delivered'; readonly at: Date }
      | { readonly kind: 'retry'; readonly at: Date; readonly reason: string }
      | { readonly kind: 'abandoned'; readonly reason: string },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO webhook_delivery_attempts
           (delivery_id, attempt_number, outcome, response_status, resolved_address,
            response_snippet, duration_milliseconds, failure_reason, used_private_allowlist)
         VALUES ($1,$2,$3::webhook_attempt_outcome,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (delivery_id, attempt_number) DO NOTHING`,
        [
          attempt.deliveryId,
          attempt.attemptNumber,
          attempt.outcome,
          attempt.responseStatus,
          attempt.resolvedAddress,
          attempt.responseSnippet,
          attempt.durationMilliseconds,
          attempt.failureReason,
          attempt.usedPrivateAllowlist,
        ],
      );

      const settled = settlementFor(next);
      await client.query(
        `UPDATE webhook_deliveries
            SET status = $2::webhook_delivery_status,
                attempt_count = $3,
                next_attempt_at = COALESCE($4, next_attempt_at),
                delivered_at = COALESCE($5, delivered_at),
                last_failure = $6,
                claimed_by = NULL,
                claim_expires_at = NULL,
                updated_at = now()
          WHERE id = $1
            -- Only the worker that still holds the claim may settle it. A slow worker whose lease
            -- expired mid-flight would otherwise clobber the state written by the one that took over,
            -- resetting a delivered row to a retry or a retry to delivered.
            AND claimed_by = $7`,
        [
          attempt.deliveryId,
          settled.status,
          attempt.attemptNumber,
          settled.nextAttemptAt,
          settled.deliveredAt,
          settled.lastFailure,
          attempt.claimedBy,
        ],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Puts a delivery back in the queue on an operator's instruction.
   *
   * The identifier does not change, so the merchant receives the same `webhook-id` they would have
   * received the first time and can deduplicate it. That is the point: a redelivery is the same event
   * again, not a new one, and a merchant who did process the original must be able to tell.
   */
  async requeue(
    deliveryId: string,
    merchantId: string,
    now: Date,
  ): Promise<WebhookDelivery | null> {
    const result = await this.pool.query<DeliveryRow>(
      // A new cycle, not a new delivery: the identifier is unchanged, so the merchant recognises the
      // repeat and deduplicates on it. attempt_count keeps rising so the attempts already made stay
      // in the history, while the schedule and the age ceiling both start again from here.
      `UPDATE webhook_deliveries
          SET status = 'pending',
              next_attempt_at = $3,
              schedule_offset = attempt_count,
              cycle_started_at = $3,
              claimed_by = NULL,
              claim_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND merchant_id = $2
          AND status <> 'in_flight'
      RETURNING ${DELIVERY_COLUMNS}`,
      [deliveryId, merchantId, now],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toDelivery(row);
  }

  /** Returns claims whose lease expired, so a worker that died does not strand a merchant's queue. */
  async releaseExpiredClaims(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE webhook_deliveries
          SET status = 'failed', claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE status = 'in_flight' AND claim_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  /** Cursor pagination on the identifier, which sorts by creation because it is a ULID. */
  async list(filter: DeliveryListFilter): Promise<DeliveryPage> {
    const conditions = ['merchant_id = $1', 'environment = $2::environment_name'];
    const values: unknown[] = [filter.merchantId, filter.environment];

    if (filter.status !== undefined) {
      values.push(filter.status);
      conditions.push(`status = $${values.length.toString()}::webhook_delivery_status`);
    }
    if (filter.paymentId !== undefined) {
      values.push(filter.paymentId);
      conditions.push(`payment_id = $${values.length.toString()}`);
    }
    if (filter.startingAfter !== undefined) {
      values.push(filter.startingAfter);
      conditions.push(`id < $${values.length.toString()}`);
    }

    // One more than asked for, so "is there another page" is answered without a second count query.
    values.push(filter.limit + 1);
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
        WHERE ${conditions.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${values.length.toString()}`,
      values,
    );

    const hasMore = result.rows.length > filter.limit;
    const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
    return {
      deliveries: rows.map((row) => toDelivery(row)),
      hasMore,
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    };
  }

  async findByPayment(paymentId: string): Promise<readonly WebhookDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
        WHERE payment_id = $1 ORDER BY created_at DESC`,
      [paymentId],
    );
    return result.rows.map((row) => toDelivery(row));
  }

  async findById(deliveryId: string, merchantId: string): Promise<WebhookDelivery | null> {
    const result = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = $1 AND merchant_id = $2`,
      [deliveryId, merchantId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toDelivery(row);
  }

  async attemptsFor(deliveryId: string): Promise<readonly DeliveryAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT delivery_id, attempt_number, outcome, response_status, resolved_address,
              response_snippet, duration_milliseconds, failure_reason, used_private_allowlist,
              requested_at
         FROM webhook_delivery_attempts
        WHERE delivery_id = $1
        ORDER BY attempt_number DESC`,
      [deliveryId],
    );
    return result.rows.map((row) =>
      Object.freeze({
        deliveryId: row.delivery_id,
        attemptNumber: row.attempt_number,
        outcome: row.outcome,
        responseStatus: row.response_status,
        resolvedAddress: row.resolved_address,
        responseSnippet: row.response_snippet,
        durationMilliseconds: row.duration_milliseconds,
        failureReason: row.failure_reason,
        usedPrivateAllowlist: row.used_private_allowlist,
        requestedAt: row.requested_at,
      }),
    );
  }
}

function settlementFor(
  next:
    | { readonly kind: 'delivered'; readonly at: Date }
    | { readonly kind: 'retry'; readonly at: Date; readonly reason: string }
    | { readonly kind: 'abandoned'; readonly reason: string },
): {
  status: DeliveryStatus;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  lastFailure: string | null;
} {
  if (next.kind === 'delivered') {
    return { status: 'delivered', nextAttemptAt: null, deliveredAt: next.at, lastFailure: null };
  }
  if (next.kind === 'retry') {
    return {
      status: 'failed',
      nextAttemptAt: next.at,
      deliveredAt: null,
      lastFailure: next.reason,
    };
  }
  return { status: 'abandoned', nextAttemptAt: null, deliveredAt: null, lastFailure: next.reason };
}
