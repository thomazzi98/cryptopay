import type { Pool } from 'pg';

/**
 * How many requests a key has made in the current window.
 *
 * The count lives in the database because it has to be shared. An in-process counter enforces the
 * configured limit once per replica, so the real limit is the configured one times the number of
 * instances, and it changes whenever the deployment scales without anybody editing a setting.
 *
 * One statement per request, and it is an upsert rather than a read followed by a write: two
 * requests arriving together would otherwise both read the same count and both decide they were
 * under the limit. The database resolves that by making the increment atomic.
 */

/** How often the counting path sweeps closed windows. Prime-ish and large: this is housekeeping. */
const SWEEP_EVERY_REQUESTS = 997;

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  /** Seconds until the current window ends, which is what a caller needs to know to retry. */
  readonly retryAfterSeconds: number;
}

export class RateLimitRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Counts this request and says whether it is within budget.
   *
   * The window start is computed by the database from its own clock, so a machine whose clock has
   * drifted cannot give one caller a wider budget than another. Counting happens whether or not the
   * request is allowed: a caller hammering a limit should not have their next window start early
   * because their refused requests were not counted.
   */
  async record(apiKeyId: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict> {
    const result = await this.pool.query<{ request_count: number; retry_after: string }>(
      // The limit is compared in TypeScript rather than bound as a parameter. A bound value the
      // statement never references leaves PostgreSQL unable to infer its type, and it refuses the
      // statement rather than ignoring the extra argument.
      `INSERT INTO api_key_rate_windows (api_key_id, window_started, request_count)
       VALUES (
         $1,
         to_timestamp(floor(extract(epoch FROM now()) / $2::double precision) * $2::double precision),
         1
       )
       ON CONFLICT (api_key_id, window_started)
       DO UPDATE SET request_count = api_key_rate_windows.request_count + 1
       RETURNING request_count,
                 ceil(extract(epoch FROM
                   (window_started + make_interval(secs => $2::double precision) - now())))::text
                   AS retry_after`,
      [apiKeyId, windowSeconds],
    );

    const row = result.rows[0];
    if (row === undefined) {
      // The key was deleted between authentication and this statement. Refusing is the safe answer.
      return { allowed: false, count: 0, limit, retryAfterSeconds: windowSeconds };
    }

    // Swept from the counting path on roughly one request in a thousand. Cheap enough to be
    // invisible, frequent enough that the table cannot grow without bound, and it needs no
    // scheduler. A failure here must never fail the request that triggered it.
    if (row.request_count % SWEEP_EVERY_REQUESTS === 0) {
      try {
        await this.removeExpiredWindows(windowSeconds);
      } catch {
        // Housekeeping must never fail the request that triggered it.
      }
    }

    return {
      allowed: row.request_count <= limit,
      count: row.request_count,
      limit,
      retryAfterSeconds: Math.max(1, Number(row.retry_after)),
    };
  }

  /**
   * Removes windows that have closed.
   *
   * Called from the counting path itself, on a small fraction of requests, rather than from a
   * schedule: the table is tiny by construction and a background job would be another process to
   * operate. It was previously called from nowhere at all while two comments claimed otherwise, so
   * the table grew one row per key per window forever.
   */
  async removeExpiredWindows(windowSeconds: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM api_key_rate_windows
        WHERE window_started < now() - make_interval(secs => $1::double precision * 2)`,
      [windowSeconds],
    );
    return result.rowCount ?? 0;
  }
}
