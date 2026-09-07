import type { NetworkIdentifier } from '@cryptopay/shared';
import type { Pool } from 'pg';

import type { TransferClassification } from '../../domain/transfer-ledger.js';

/**
 * Reading back what the chain showed.
 *
 * The scanner writes raw observations through {@link ChainScanStore}; deciding what they mean to a
 * payment happens later, against the rows read here. Splitting the two is what lets scanning be
 * replayed freely, and it keeps the credited total a function of stored rows rather than of the
 * order events happened to arrive in.
 */

export interface StoredTransfer {
  readonly identifier: string;
  readonly paymentId: string;
  readonly transactionReference: string;
  readonly eventIndex: number;
  readonly blockHeight: bigint;
  readonly blockReference: string;
  readonly sourceAccount: string;
  readonly assetReference: string;
  readonly amountInBaseUnits: bigint;
  readonly classification: TransferClassification;
  readonly observation: 'observed' | 'finalized' | 'orphaned';
  readonly orphaned: boolean;
  readonly observedAt: Date;
}

interface TransferRow {
  readonly id: string;
  readonly payment_id: string;
  readonly transaction_reference: string;
  readonly event_index: number;
  readonly block_height: string;
  readonly block_reference: string;
  readonly source_account: string;
  readonly asset_reference: string;
  readonly amount: string;
  readonly classification: TransferClassification;
  readonly observation: 'observed' | 'finalized' | 'orphaned';
  readonly orphaned_at: Date | null;
  readonly observed_at: Date;
}

function toStoredTransfer(row: TransferRow): StoredTransfer {
  return Object.freeze({
    identifier: row.id,
    paymentId: row.payment_id,
    transactionReference: row.transaction_reference,
    eventIndex: row.event_index,
    blockHeight: BigInt(row.block_height),
    blockReference: row.block_reference,
    sourceAccount: row.source_account,
    assetReference: row.asset_reference,
    amountInBaseUnits: BigInt(row.amount),
    classification: row.classification,
    observation: row.observation,
    orphaned: row.orphaned_at !== null,
    observedAt: row.observed_at,
  });
}

const TRANSFER_COLUMNS = `id, payment_id, transaction_reference, event_index, block_height,
  block_reference, source_account, asset_reference, amount, classification, observation,
  orphaned_at, observed_at`;

export class PaymentTransferRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Every transfer ever recorded against a payment, orphaned ones included. Nothing is hidden: a
   * customer whose money was withdrawn by a reorg, or who sent the wrong token, needs to see that it
   * arrived and why it did not count.
   */
  async findByPayment(paymentId: string): Promise<readonly StoredTransfer[]> {
    const result = await this.pool.query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS} FROM payment_transfers
        WHERE payment_id = $1 ORDER BY block_height, event_index`,
      [paymentId],
    );
    return result.rows.map((row) => toStoredTransfer(row));
  }

  /** Stops re-checking a transfer once its block can no longer be reorganised away. */
  async markFinalizedUpTo(networkIdentifier: NetworkIdentifier, height: bigint): Promise<number> {
    const result = await this.pool.query(
      `UPDATE payment_transfers
          SET observation = 'finalized', finalized_at = now()
        WHERE network_identifier = $1::network_identifier
          AND observation = 'observed'
          AND block_height <= $2`,
      [networkIdentifier, height.toString()],
    );
    return result.rowCount ?? 0;
  }
}
