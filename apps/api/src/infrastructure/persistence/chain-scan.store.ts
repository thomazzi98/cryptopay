import type { LedgerHeader, NetworkIdentifier, ObservedTransfer } from '@cryptopay/shared';
import type { Pool, PoolClient } from 'pg';

import type { TransferClassification } from '../../domain/transfer-ledger.js';

/**
 * The scanner's atomic writes.
 *
 * Both operations here span four tables, and in both cases the atomicity is the point rather than an
 * implementation detail, so they live together in one place that owns the transaction instead of
 * being spread across the repositories of the tables they touch.
 */

export interface RecordableTransfer {
  readonly identifier: string;
  readonly paymentId: string;
  readonly transfer: ObservedTransfer;
  readonly classification: TransferClassification;
}

export interface ScannedWindow {
  readonly networkIdentifier: NetworkIdentifier;
  readonly transfers: readonly RecordableTransfer[];
  readonly headers: readonly LedgerHeader[];
  readonly scannedThrough: LedgerHeader;
  readonly finalizedHeight: bigint | null;
  readonly nextScanRange: number;
  readonly consecutiveSuccesses: number;
  /** Carried into the cursor write, so a worker that has lost its lease writes nothing. */
  readonly fencingToken: bigint;
}

export interface ForkRewind {
  readonly networkIdentifier: NetworkIdentifier;
  readonly forkHeight: bigint;
  readonly forkReference: string;
  readonly fencingToken: bigint;
}

export interface ForkRewindOutcome {
  readonly applied: boolean;
  readonly orphanedTransfers: number;
  readonly affectedPayments: readonly string[];
}

export class ChainScanStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Commits one scanned window: the transfers, the headers covering it, the payments that now need
   * re-evaluating, and the cursor advance, in a single transaction.
   *
   * A transfer that is already recorded is updated to its new position rather than skipped. A reorg
   * usually returns the transaction to the mempool and it is re-mined into a different block, keeping
   * the same transaction identity; skipping the conflict would leave that row orphaned forever and
   * lose a customer's payment. The amount and the classification are deliberately left untouched:
   * both were decided when the transfer was first seen, and neither changes because a block did.
   *
   * The cursor moves only with the data it covers. A crash anywhere inside this transaction replays
   * the identical window on restart, and the uniqueness constraint on
   * (network_identifier, transaction_reference, event_index) makes the replay a no-op. That is what
   * turns at-least-once scanning into exactly-once crediting, and it means the recovery path is
   * exercised by every ordinary tick rather than only by a crash.
   *
   * Returns false when the fencing token no longer matches the cursor, which means another worker
   * holds the lease. Nothing is written in that case.
   */
  async commitScannedWindow(window: ScannedWindow): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const record of window.transfers) {
        await client.query(
          `INSERT INTO payment_transfers
             (id, payment_id, network_identifier, transaction_reference, event_index, block_height,
              block_reference, source_account, asset_reference, amount, classification)
           VALUES ($1,$2,$3::network_identifier,$4,$5,$6,$7,$8,$9,$10,$11::transfer_classification)
           ON CONFLICT (network_identifier, transaction_reference, event_index) DO UPDATE
             SET block_height = EXCLUDED.block_height,
                 block_reference = EXCLUDED.block_reference,
                 observation = 'observed',
                 orphaned_at = NULL,
                 finalized_at = NULL`,
          [
            record.identifier,
            record.paymentId,
            window.networkIdentifier,
            record.transfer.reference.transactionReference,
            record.transfer.reference.eventIndex,
            record.transfer.position.height.toString(),
            record.transfer.position.reference,
            record.transfer.sourceAccount,
            record.transfer.assetReference,
            record.transfer.amountInBaseUnits.toString(),
            record.classification,
          ],
        );
      }

      // A rescanned height can legitimately carry a different block: that is a reorg the ancestry
      // check has already resolved, so the newer header replaces the older one.
      for (const header of window.headers) {
        await client.query(
          `INSERT INTO observed_blocks
             (network_identifier, block_height, block_reference, parent_reference)
           VALUES ($1::network_identifier,$2,$3,$4)
           ON CONFLICT (network_identifier, block_height) DO UPDATE
             SET block_reference = EXCLUDED.block_reference,
                 parent_reference = EXCLUDED.parent_reference,
                 observed_at = now()`,
          [
            window.networkIdentifier,
            header.position.height.toString(),
            header.position.reference,
            header.parentReference,
          ],
        );
      }

      await enqueueForEvaluation(
        client,
        window.transfers.map((record) => record.paymentId),
      );

      const advanced = await client.query(
        `UPDATE block_cursors
            SET last_scanned_height = $2,
                last_scanned_reference = $3,
                finalized_height = COALESCE($4, finalized_height),
                finalized_advanced_at = CASE
                  WHEN $4 IS NOT NULL AND $4::bigint IS DISTINCT FROM finalized_height
                  THEN now()
                  ELSE finalized_advanced_at
                END,
                current_scan_range = $5,
                consecutive_successes = $6,
                updated_at = now()
          WHERE network_identifier = $1::network_identifier
            AND fencing_token = $7
            AND halted_at IS NULL`,
        [
          window.networkIdentifier,
          window.scannedThrough.position.height.toString(),
          window.scannedThrough.position.reference,
          window.finalizedHeight?.toString() ?? null,
          window.nextScanRange,
          window.consecutiveSuccesses,
          window.fencingToken.toString(),
        ],
      );

      if (advanced.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Withdraws everything observed above a fork point and rewinds the cursor to it, in one
   * transaction. Splitting the two would leave a window in which money that no longer exists on the
   * canonical chain is still credited to a payment, and that window is long enough for the
   * evaluation worker to complete it.
   *
   * The rewind never moves the cursor forward, so a stale rewind cannot skip unscanned blocks.
   */
  async commitForkRewind(rewind: ForkRewind): Promise<ForkRewindOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const rewound = await client.query(
        `UPDATE block_cursors
            SET last_scanned_height = $2,
                last_scanned_reference = $3,
                updated_at = now()
          WHERE network_identifier = $1::network_identifier
            AND fencing_token = $4
            AND halted_at IS NULL
            AND last_scanned_height > $2`,
        [
          rewind.networkIdentifier,
          rewind.forkHeight.toString(),
          rewind.forkReference,
          rewind.fencingToken.toString(),
        ],
      );

      if (rewound.rowCount === 0) {
        await client.query('ROLLBACK');
        return { applied: false, orphanedTransfers: 0, affectedPayments: [] };
      }

      const orphaned = await client.query<{ payment_id: string }>(
        `UPDATE payment_transfers
            SET observation = 'orphaned', orphaned_at = now()
          WHERE network_identifier = $1::network_identifier
            AND block_height > $2
            AND orphaned_at IS NULL
        RETURNING payment_id`,
        [rewind.networkIdentifier, rewind.forkHeight.toString()],
      );

      await client.query(
        `DELETE FROM observed_blocks
          WHERE network_identifier = $1::network_identifier AND block_height > $2`,
        [rewind.networkIdentifier, rewind.forkHeight.toString()],
      );

      const affectedPayments = [...new Set(orphaned.rows.map((row) => row.payment_id))];
      await enqueueForEvaluation(client, affectedPayments);

      await client.query('COMMIT');
      return { applied: true, orphanedTransfers: orphaned.rowCount ?? 0, affectedPayments };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function enqueueForEvaluation(
  client: PoolClient,
  paymentIdentifiers: readonly string[],
): Promise<void> {
  const distinct = new Set(paymentIdentifiers);
  for (const paymentId of distinct) {
    await client.query(
      `INSERT INTO payment_evaluation_queue (payment_id) VALUES ($1)
       ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId],
    );
  }
}
