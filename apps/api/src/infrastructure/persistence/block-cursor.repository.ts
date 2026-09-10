import type { NetworkIdentifier } from '@cryptopay/shared';
import type { Pool } from 'pg';

/**
 * Where scanning has reached on each network.
 *
 * Payment creation reads this too, and refuses when a network has no cursor. Accepting money on a
 * chain no scanner is watching would leave the customer's transfer unobserved indefinitely; a clear
 * refusal is a far better outcome than a payment that can never complete.
 */

export interface BlockCursor {
  readonly networkIdentifier: NetworkIdentifier;
  readonly lastScannedHeight: bigint;
  readonly lastScannedReference: string;
  readonly finalizedHeight: bigint | null;
  /** When the finalized height last moved. Null until a network reports one for the first time. */
  readonly finalizedAdvancedAt: Date | null;
  readonly currentScanRange: number;
  readonly consecutiveSuccesses: number;
  readonly haltedAt: Date | null;
  readonly haltedReason: string | null;
  readonly fencingToken: bigint;
  readonly updatedAt: Date;
}

interface CursorRow {
  readonly network_identifier: NetworkIdentifier;
  readonly last_scanned_height: string;
  readonly last_scanned_reference: string;
  readonly finalized_height: string | null;
  readonly finalized_advanced_at: Date | null;
  readonly current_scan_range: number;
  readonly consecutive_successes: number;
  readonly halted_at: Date | null;
  readonly halted_reason: string | null;
  readonly fencing_token: string;
  readonly updated_at: Date;
}

function toCursor(row: CursorRow): BlockCursor {
  return Object.freeze({
    networkIdentifier: row.network_identifier,
    lastScannedHeight: BigInt(row.last_scanned_height),
    lastScannedReference: row.last_scanned_reference,
    finalizedHeight: row.finalized_height === null ? null : BigInt(row.finalized_height),
    finalizedAdvancedAt: row.finalized_advanced_at,
    currentScanRange: row.current_scan_range,
    consecutiveSuccesses: row.consecutive_successes,
    haltedAt: row.halted_at,
    haltedReason: row.halted_reason,
    fencingToken: BigInt(row.fencing_token),
    updatedAt: row.updated_at,
  });
}

const CURSOR_COLUMNS = `network_identifier, last_scanned_height, last_scanned_reference,
  finalized_height, finalized_advanced_at, current_scan_range, consecutive_successes,
  halted_at, halted_reason,
  fencing_token, updated_at`;

export class BlockCursorRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async find(network: NetworkIdentifier): Promise<BlockCursor | null> {
    const result = await this.pool.query<CursorRow>(
      `SELECT ${CURSOR_COLUMNS} FROM block_cursors WHERE network_identifier = $1::network_identifier`,
      [network],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toCursor(row);
  }

  async findAll(): Promise<readonly BlockCursor[]> {
    const result = await this.pool.query<CursorRow>(`SELECT ${CURSOR_COLUMNS} FROM block_cursors`);
    return result.rows.map((row) => toCursor(row));
  }

  /**
   * Records where a network starts being watched. Does nothing if a cursor already exists, so a
   * restart never rewinds progress.
   */
  async initialiseIfAbsent(
    network: NetworkIdentifier,
    height: bigint,
    reference: string,
    scanRange: number,
  ): Promise<BlockCursor> {
    await this.pool.query(
      `INSERT INTO block_cursors
         (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
       VALUES ($1::network_identifier, $2, $3, $4)
       ON CONFLICT (network_identifier) DO NOTHING`,
      [network, height.toString(), reference, scanRange],
    );

    const cursor = await this.find(network);
    if (cursor === null) {
      throw new Error(`Could not initialise the block cursor for ${network}`);
    }
    return cursor;
  }

  /**
   * Stamps the lease token this worker holds onto the cursor, and refuses if a higher one is already
   * there. Every subsequent write carries the same token, so a worker that hung long enough to lose
   * its lease finds its writes affecting zero rows rather than overwriting the new holder's progress.
   */
  async adoptLease(network: NetworkIdentifier, fencingToken: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE block_cursors SET fencing_token = $2, updated_at = now()
        WHERE network_identifier = $1::network_identifier AND fencing_token <= $2`,
      [network, fencingToken.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Stops scanning a network and records why.
   *
   * Halting is the designed response to an anomaly the scanner cannot resolve safely: a fork deeper
   * than the limit, or providers that disagree. Continuing to guess during an anomaly is how a
   * processor credits money that is not there, so stopping loudly is the cheaper failure. Resuming is
   * an explicit operator decision, never automatic.
   */
  async halt(network: NetworkIdentifier, reason: string, fencingToken: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE block_cursors SET halted_at = now(), halted_reason = $2, updated_at = now()
        WHERE network_identifier = $1::network_identifier
          AND fencing_token = $3
          AND halted_at IS NULL`,
      [network, reason, fencingToken.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Records how far finality has reached while nothing new was scanned.
   *
   * Finality advances on its own schedule, so a caught-up scanner still has something to write. The
   * timestamp moves only when the height actually changes, which is what makes a stalled finality
   * view detectable rather than indistinguishable from a quiet chain.
   */
  async recordFinality(
    network: NetworkIdentifier,
    finalizedHeight: bigint | null,
    fencingToken: bigint,
  ): Promise<boolean> {
    if (finalizedHeight === null) {
      return false;
    }
    const result = await this.pool.query(
      `UPDATE block_cursors
          SET finalized_height = $2,
              finalized_advanced_at = CASE
                WHEN $2::bigint IS DISTINCT FROM finalized_height THEN now()
                ELSE finalized_advanced_at
              END,
              updated_at = now()
        WHERE network_identifier = $1::network_identifier
          AND fencing_token = $3
          AND halted_at IS NULL`,
      [network, finalizedHeight.toString(), fencingToken.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resume(network: NetworkIdentifier): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE block_cursors SET halted_at = NULL, halted_reason = NULL, updated_at = now()
        WHERE network_identifier = $1::network_identifier AND halted_at IS NOT NULL`,
      [network],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
