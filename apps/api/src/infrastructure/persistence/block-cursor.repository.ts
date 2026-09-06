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
  readonly currentScanRange: number;
  readonly haltedAt: Date | null;
  readonly haltedReason: string | null;
  readonly fencingToken: bigint;
}

interface CursorRow {
  readonly network_identifier: NetworkIdentifier;
  readonly last_scanned_height: string;
  readonly last_scanned_reference: string;
  readonly finalized_height: string | null;
  readonly current_scan_range: number;
  readonly halted_at: Date | null;
  readonly halted_reason: string | null;
  readonly fencing_token: string;
}

function toCursor(row: CursorRow): BlockCursor {
  return Object.freeze({
    networkIdentifier: row.network_identifier,
    lastScannedHeight: BigInt(row.last_scanned_height),
    lastScannedReference: row.last_scanned_reference,
    finalizedHeight: row.finalized_height === null ? null : BigInt(row.finalized_height),
    currentScanRange: row.current_scan_range,
    haltedAt: row.halted_at,
    haltedReason: row.halted_reason,
    fencingToken: BigInt(row.fencing_token),
  });
}

const CURSOR_COLUMNS = `network_identifier, last_scanned_height, last_scanned_reference,
  finalized_height, current_scan_range, halted_at, halted_reason, fencing_token`;

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
}
