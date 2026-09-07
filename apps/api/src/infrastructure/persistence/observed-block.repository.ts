import type { NetworkIdentifier } from '@cryptopay/shared';
import type { Pool } from 'pg';

/**
 * The header chain the scanner keeps for itself.
 *
 * Fork resolution walks these rows rather than the payments table. Walking payments instead cannot
 * locate a fork in a window that contained no transfers, which is the overwhelmingly common case, so
 * an ordinary one-block reorg would exhaust the depth limit and halt a perfectly healthy network.
 */

export interface StoredHeader {
  readonly height: bigint;
  readonly reference: string;
  readonly parentReference: string;
}

interface HeaderRow {
  readonly block_height: string;
  readonly block_reference: string;
  readonly parent_reference: string;
}

function toStoredHeader(row: HeaderRow): StoredHeader {
  return Object.freeze({
    height: BigInt(row.block_height),
    reference: row.block_reference,
    parentReference: row.parent_reference,
  });
}

export class ObservedBlockRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Highest first, which is the order the ancestry walk consumes them in. */
  async findDescendingFrom(
    network: NetworkIdentifier,
    fromHeight: bigint,
    limit: number,
  ): Promise<readonly StoredHeader[]> {
    const result = await this.pool.query<HeaderRow>(
      `SELECT block_height, block_reference, parent_reference FROM observed_blocks
        WHERE network_identifier = $1::network_identifier AND block_height <= $2
        ORDER BY block_height DESC
        LIMIT $3`,
      [network, fromHeight.toString(), limit],
    );
    return result.rows.map((row) => toStoredHeader(row));
  }

  /**
   * Discards headers no reorg can still reach. The ring is bounded by the depth limit, so retaining
   * more is storage spent on questions that will never be asked.
   */
  async pruneBelow(network: NetworkIdentifier, height: bigint): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM observed_blocks
        WHERE network_identifier = $1::network_identifier AND block_height < $2`,
      [network, height.toString()],
    );
    return result.rowCount ?? 0;
  }
}
