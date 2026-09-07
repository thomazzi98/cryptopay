import type { Environment, NetworkIdentifier, PaymentStatus } from '@cryptopay/shared';
import type { Pool, PoolClient } from 'pg';

import type { Payment } from '../../domain/payment.js';
import type { AllocatedPaymentAddress } from '../wallet/hierarchical-deterministic-allocator.js';

/**
 * Persistence for the payment aggregate.
 *
 * Concrete rather than behind an interface. There will only ever be one implementation, the
 * integration tests run against a real PostgreSQL — which exercises the partial indexes, the
 * compare-and-swap and SKIP LOCKED that an in-memory fake could not — and an interface whose only
 * second implementation is a fake is cost without benefit.
 *
 * Every write that changes a payment is a compare-and-swap on `status_version`. A row count of zero
 * means another writer won; the caller reloads and re-runs the pure command, which almost always
 * returns `ignored`. Holding a lock across the decision instead would mean holding it across I/O.
 */

interface PaymentRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly environment: Environment;
  readonly network_identifier: NetworkIdentifier;
  readonly checkout_token: string;
  readonly asset_reference: string;
  readonly asset_symbol: string;
  readonly asset_decimals: number;
  readonly requested_amount: string;
  readonly minimum_acceptable_amount: string;
  readonly maximum_acceptable_amount: string;
  readonly credited_amount: string;
  readonly receiving_account: string;
  readonly status: PaymentStatus;
  readonly status_version: number;
  readonly required_confirmations: number;
  readonly requires_finality_tag: boolean;
  readonly confirmations_observed: number;
  readonly finality_confirmed: boolean;
  readonly settling_block_height: string | null;
  readonly created_at_block_height: string;
  readonly merchant_reference: string | null;
  readonly callback_url: string | null;
  readonly metadata: Record<string, string>;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly completed_at: Date | null;
}

const PAYMENT_COLUMNS = `
  id, merchant_id, environment, network_identifier, checkout_token,
  asset_reference, asset_symbol, asset_decimals,
  requested_amount, minimum_acceptable_amount, maximum_acceptable_amount, credited_amount,
  receiving_account, status, status_version,
  required_confirmations, requires_finality_tag, confirmations_observed, finality_confirmed,
  settling_block_height, created_at_block_height,
  merchant_reference, callback_url, metadata, created_at, expires_at, completed_at
`;

function toPayment(row: PaymentRow): Payment {
  return Object.freeze({
    identifier: row.id,
    merchantId: row.merchant_id,
    environment: row.environment,
    networkIdentifier: row.network_identifier,
    checkoutToken: row.checkout_token,

    asset: Object.freeze({
      networkIdentifier: row.network_identifier,
      reference: row.asset_reference,
      symbol: row.asset_symbol,
      decimals: row.asset_decimals,
    }),
    // NUMERIC arrives as a string precisely so it is never rounded; BigInt is the only safe parse.
    requestedAmountInBaseUnits: BigInt(row.requested_amount),
    acceptanceBand: Object.freeze({
      minimumInBaseUnits: BigInt(row.minimum_acceptable_amount),
      maximumInBaseUnits: BigInt(row.maximum_acceptable_amount),
    }),
    creditedAmountInBaseUnits: BigInt(row.credited_amount),

    receivingAccount: row.receiving_account,
    status: row.status,
    statusVersion: row.status_version,

    requiredConfirmations: row.required_confirmations,
    requiresFinalityTag: row.requires_finality_tag,
    confirmationsObserved: row.confirmations_observed,
    finalityConfirmed: row.finality_confirmed,
    settlingBlockHeight:
      row.settling_block_height === null ? null : BigInt(row.settling_block_height),
    createdAtBlockHeight: BigInt(row.created_at_block_height),

    merchantReference: row.merchant_reference,
    callbackUrl: row.callback_url,
    metadata: Object.freeze({ ...row.metadata }),

    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  });
}

export interface PaymentListFilter {
  readonly merchantId: string;
  readonly environment: Environment;
  readonly status?: PaymentStatus;
  readonly networkIdentifier?: NetworkIdentifier;
  readonly merchantReference?: string;
  readonly createdAfter?: Date;
  readonly createdBefore?: Date;
  readonly limit: number;
  readonly startingAfter?: string;
}

export interface PaymentPage {
  readonly payments: readonly Payment[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface SaveTransitionInput {
  readonly payment: Payment;
  /** The status before the command was applied; the audit trail records the edge, not the endpoint. */
  readonly previousStatus: PaymentStatus;
  readonly expectedVersion: number;
  readonly command: string;
  readonly causedBy: string | null;
}

export interface CreatePaymentRecord {
  readonly payment: Payment;
  readonly address: AllocatedPaymentAddress;
  readonly addressIdentifier: string;
  readonly derivationIndex: number;
  /** Runs inside the same transaction, so the stored response cannot exist without the payment. */
  readonly withinTransaction?: (client: PoolClient) => Promise<void>;
}

export class PaymentRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Writes the payment, the address it owns and anything the caller needs committed alongside them
   * in a single transaction. A payment without its address, or a stored idempotent response without
   * its payment, is therefore not a state the database can hold.
   */
  async create(record: CreatePaymentRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { payment, address } = record;

      await client.query(
        `INSERT INTO payments (${PAYMENT_COLUMNS})
         VALUES ($1,$2,$3::environment_name,$4::network_identifier,$5,
                 $6,$7,$8,
                 $9,$10,$11,$12,
                 $13,$14::payment_status,$15,
                 $16,$17,$18,$19,
                 $20,$21,
                 $22,$23,$24::jsonb,$25,$26,$27)`,
        [
          payment.identifier,
          payment.merchantId,
          payment.environment,
          payment.networkIdentifier,
          payment.checkoutToken,
          payment.asset.reference,
          payment.asset.symbol,
          payment.asset.decimals,
          payment.requestedAmountInBaseUnits.toString(),
          payment.acceptanceBand.minimumInBaseUnits.toString(),
          payment.acceptanceBand.maximumInBaseUnits.toString(),
          payment.creditedAmountInBaseUnits.toString(),
          payment.receivingAccount,
          payment.status,
          payment.statusVersion,
          payment.requiredConfirmations,
          payment.requiresFinalityTag,
          payment.confirmationsObserved,
          payment.finalityConfirmed,
          payment.settlingBlockHeight?.toString() ?? null,
          payment.createdAtBlockHeight.toString(),
          payment.merchantReference,
          payment.callbackUrl,
          JSON.stringify(payment.metadata),
          payment.createdAt,
          payment.expiresAt,
          payment.completedAt,
        ],
      );

      await client.query(
        `INSERT INTO payment_addresses
           (id, payment_id, environment, network_identifier, account, derivation_index, allocation_reference)
         VALUES ($1,$2,$3::environment_name,$4::network_identifier,$5,$6,$7)`,
        [
          record.addressIdentifier,
          payment.identifier,
          payment.environment,
          payment.networkIdentifier,
          address.account,
          record.derivationIndex,
          address.allocationReference,
        ],
      );

      await record.withinTransaction?.(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(merchantId: string, paymentId: string): Promise<Payment | null> {
    // Scoped by merchant in the query rather than checked afterwards, so a missing row and another
    // merchant's row are indistinguishable and both answer 404.
    const result = await this.pool.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 AND merchant_id = $2`,
      [paymentId, merchantId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toPayment(row);
  }

  async findByCheckoutToken(checkoutToken: string): Promise<Payment | null> {
    const result = await this.pool.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE checkout_token = $1`,
      [checkoutToken],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return toPayment(row);
  }

  /**
   * The addresses the scanner filters chain logs by.
   *
   * Terminal payments stay watched for a grace period so a transfer that arrives after expiry is
   * still recorded. It will be classified `late` and will not move the payment, but a customer whose
   * money arrived four minutes too late needs it to be visible and recoverable rather than invisible.
   */
  async findWatchedAccounts(
    network: NetworkIdentifier,
    terminalGraceSeconds: number,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ receiving_account: string }>(
      `SELECT DISTINCT receiving_account FROM payments
        WHERE network_identifier = $1::network_identifier
          AND (status IN ('pending', 'partially_funded', 'confirming')
               OR updated_at > now() - make_interval(secs => $2))`,
      [network, terminalGraceSeconds],
    );
    return result.rows.map((row) => row.receiving_account);
  }

  /**
   * Resolves observed transfers back to the payments they were sent to. A payment address is unique
   * per network by constraint, so this mapping is one to one and cannot silently credit the wrong
   * payment.
   */
  async findByReceivingAccounts(
    network: NetworkIdentifier,
    accounts: readonly string[],
  ): Promise<readonly Payment[]> {
    if (accounts.length === 0) {
      return [];
    }
    const result = await this.pool.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
        WHERE network_identifier = $1::network_identifier AND receiving_account = ANY($2::text[])`,
      [network, [...accounts]],
    );
    return result.rows.map((row) => toPayment(row));
  }

  /**
   * Loads payments by identifier without a merchant scope. Used only by the workers, which act on
   * behalf of the system rather than of a caller; every path a merchant can reach goes through
   * findById, which scopes in the query so another merchant's payment answers 404.
   */
  async findByIdentifiers(identifiers: readonly string[]): Promise<readonly Payment[]> {
    if (identifiers.length === 0) {
      return [];
    }
    const result = await this.pool.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ANY($1::text[])`,
      [[...identifiers]],
    );
    return result.rows.map((row) => toPayment(row));
  }

  /**
   * Records figures that changed without the status changing, under the same compare-and-swap.
   *
   * No audit row is written. A confirmation count advances on nearly every tick while a payment is
   * confirming, and a transition row for each would bury the handful that matter under hundreds that
   * do not. The compare-and-swap still applies, so this can never overwrite a concurrent transition.
   */
  async saveProgress(payment: Payment, expectedVersion: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE payments
          SET credited_amount = $3,
              confirmations_observed = $4,
              finality_confirmed = $5,
              settling_block_height = $6,
              first_credited_at = CASE
                WHEN first_credited_at IS NULL AND $3::numeric > 0 THEN now()
                ELSE first_credited_at
              END,
              updated_at = now()
        WHERE id = $1 AND status_version = $2`,
      [
        payment.identifier,
        expectedVersion,
        payment.creditedAmountInBaseUnits.toString(),
        payment.confirmationsObserved,
        payment.finalityConfirmed,
        payment.settlingBlockHeight?.toString() ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(filter: PaymentListFilter): Promise<PaymentPage> {
    const conditions = ['merchant_id = $1', 'environment = $2::environment_name'];
    const values: unknown[] = [filter.merchantId, filter.environment];

    // Each clause is built from the bound-parameter index, so no value is ever interpolated into
    // SQL text. The index comes from the running count of bound values, never from request input.
    const addCondition = (
      buildClause: (parameterIndex: number) => string,
      value: unknown,
    ): void => {
      values.push(value);
      conditions.push(buildClause(values.length));
    };

    if (filter.status !== undefined) {
      addCondition((index) => `status = $${index}::payment_status`, filter.status);
    }
    if (filter.networkIdentifier !== undefined) {
      addCondition(
        (index) => `network_identifier = $${index}::network_identifier`,
        filter.networkIdentifier,
      );
    }
    if (filter.merchantReference !== undefined) {
      addCondition((index) => `merchant_reference = $${index}`, filter.merchantReference);
    }
    if (filter.createdAfter !== undefined) {
      addCondition((index) => `created_at > $${index}`, filter.createdAfter);
    }
    if (filter.createdBefore !== undefined) {
      addCondition((index) => `created_at < $${index}`, filter.createdBefore);
    }
    // Identifiers are ULIDs, so ordering by identifier is ordering by creation time and a single
    // column is a stable cursor even for payments created in the same millisecond.
    if (filter.startingAfter !== undefined) {
      addCondition((index) => `id < $${index}`, filter.startingAfter);
    }

    values.push(filter.limit + 1);
    const result = await this.pool.query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
        WHERE ${conditions.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > filter.limit;
    const rows = hasMore ? result.rows.slice(0, filter.limit) : result.rows;
    const payments = rows.map((row) => toPayment(row));

    return {
      payments,
      hasMore,
      nextCursor: hasMore ? (payments.at(-1)?.identifier ?? null) : null,
    };
  }

  /**
   * Applies a decided transition if and only if the payment is still at the version the decision was
   * made against. Returns false when another writer won, which is an ordinary outcome the caller
   * handles by reloading rather than an error.
   */
  async saveTransition(input: SaveTransitionInput): Promise<boolean> {
    const { payment, previousStatus, expectedVersion, command, causedBy } = input;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query(
        `UPDATE payments
            SET status = $3::payment_status,
                status_version = $4,
                credited_amount = $5,
                confirmations_observed = $6,
                finality_confirmed = $7,
                settling_block_height = $8,
                completed_at = $9,
                first_credited_at = CASE
                  WHEN first_credited_at IS NULL AND $5::numeric > 0 THEN now()
                  ELSE first_credited_at
                END,
                updated_at = now()
          WHERE id = $1 AND status_version = $2`,
        [
          payment.identifier,
          expectedVersion,
          payment.status,
          payment.statusVersion,
          payment.creditedAmountInBaseUnits.toString(),
          payment.confirmationsObserved,
          payment.finalityConfirmed,
          payment.settlingBlockHeight?.toString() ?? null,
          payment.completedAt,
        ],
      );

      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      // The unique constraint on (payment_id, to_version) is the backstop: if two writers somehow
      // reached this point at one version, the second rolls the whole transaction back.
      await client.query(
        `INSERT INTO payment_status_transitions
           (payment_id, from_status, to_status, from_version, to_version, command, caused_by,
            credited_amount, confirmations)
         VALUES ($1,$2::payment_status,$3::payment_status,$4,$5,$6,$7,$8,$9)`,
        [
          payment.identifier,
          previousStatus,
          payment.status,
          expectedVersion,
          payment.statusVersion,
          command,
          causedBy,
          payment.creditedAmountInBaseUnits.toString(),
          payment.confirmationsObserved,
        ],
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
