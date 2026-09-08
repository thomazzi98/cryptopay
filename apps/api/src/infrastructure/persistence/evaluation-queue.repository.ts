import type { NetworkIdentifier } from '@cryptopay/shared';
import type { Pool } from 'pg';

/**
 * Which payments are waiting to be re-evaluated.
 *
 * The scanner enqueues a payment when it observes money for it. A periodic sweep enqueues every
 * payment that is still live, because two of the things that change a payment's status arrive
 * without any transfer at all: a confirmation count advancing, and an expiry elapsing.
 *
 * Claiming uses SKIP LOCKED with a lease rather than a status column. A worker that dies holding a
 * claim releases it by expiry; a worker that is merely slow does not have its work stolen and then
 * done twice, because the compare-and-swap on the payment refuses the second writer regardless.
 */

export class EvaluationQueueRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Adds every payment on this network that could still change. Cheap by construction: payments are
   * short lived, so the live set is bounded by the lifetime rather than by total volume.
   */
  async enqueueLivePayments(network: NetworkIdentifier): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO payment_evaluation_queue (payment_id)
       SELECT id FROM payments
        WHERE network_identifier = $1::network_identifier
          AND status IN ('pending', 'partially_funded', 'confirming')
       ON CONFLICT (payment_id) DO NOTHING`,
      [network],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Queues one payment now, ahead of the next sweep.
   *
   * Used by the browser hint, which is a latency optimisation and nothing more: the payment is
   * looked at sooner, and every figure is still re-derived from the chain.
   */
  async enqueue(paymentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO payment_evaluation_queue (payment_id) VALUES ($1)
       ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId],
    );
    // Whether this call was the one that queued it. A payment already waiting is not queued twice,
    // and reconciliation counts what it actually caused rather than what it asked for.
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Claims work for one network only.
   *
   * Each worker holds a gateway for a single chain and judges what it claims against that chain's
   * tip and finalized height. Without this predicate a worker watching Amoy could claim a mainnet
   * payment and decide its confirmation count from Amoy's head — two numbers with no relationship,
   * and the payment either completes early or never.
   */
  async claim(
    workerIdentity: string,
    networkIdentifier: NetworkIdentifier,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ payment_id: string }>(
      `UPDATE payment_evaluation_queue queue
          SET locked_by = $1, locked_until = now() + make_interval(secs => $3)
        WHERE queue.payment_id IN (
          SELECT candidate.payment_id
            FROM payment_evaluation_queue candidate
            JOIN payments ON payments.id = candidate.payment_id
           WHERE (candidate.locked_until IS NULL OR candidate.locked_until < now())
             AND payments.network_identifier = $4::network_identifier
           ORDER BY candidate.enqueued_at, candidate.payment_id
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT $2
        )
      RETURNING queue.payment_id`,
      [workerIdentity, limit, leaseSeconds, networkIdentifier],
    );
    return result.rows.map((row) => row.payment_id);
  }

  /** Removes claims this worker finished with. A payment still live is enqueued again next sweep. */
  async release(workerIdentity: string, paymentIdentifiers: readonly string[]): Promise<number> {
    if (paymentIdentifiers.length === 0) {
      return 0;
    }
    const result = await this.pool.query(
      `DELETE FROM payment_evaluation_queue
        WHERE payment_id = ANY($2::text[]) AND locked_by = $1`,
      [workerIdentity, [...paymentIdentifiers]],
    );
    return result.rowCount ?? 0;
  }

  async depth(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM payment_evaluation_queue',
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}
