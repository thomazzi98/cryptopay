import type { Environment, NetworkIdentifier, SettlementStatus } from '@cryptopay/shared';
import { canTransitionSettlement } from '@cryptopay/shared';
import type { Pool, PoolClient } from 'pg';

import type { TreasurySpend } from '../../domain/spend-ceiling.js';

/**
 * Settlement state, and the sequence allocator that keeps two workers from signing the same slot.
 *
 * Two invariants live here rather than in the code that calls it, because a caller can be wrong and
 * a constraint cannot. A payment has at most one settlement, enforced by a unique key on payment_id.
 * An account has at most one live transaction per sequence number, enforced by a partial unique
 * index. Everything else in the settlement path is an argument that those two hold; these are the
 * reason they do.
 */

export type ChainTransactionPurpose = 'gas_funding' | 'asset_sweep';

export type ChainTransactionStatus =
  'submitted' | 'confirming' | 'confirmed' | 'reverted' | 'dropped' | 'replaced';

export interface Settlement {
  readonly identifier: string;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly networkIdentifier: NetworkIdentifier;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly assetReference: string;
  readonly amountInBaseUnits: bigint;
  readonly status: SettlementStatus;
  readonly statusVersion: number;
  readonly attemptCount: number;
  readonly failureReason: string | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
}

export interface ChainTransaction {
  readonly identifier: string;
  readonly settlementId: string;
  readonly networkIdentifier: NetworkIdentifier;
  readonly purpose: ChainTransactionPurpose;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly sequenceNumber: number;
  readonly transactionReference: string;
  readonly valueInNativeUnits: bigint;
  readonly maximumFeeInNativeUnits: bigint;
  readonly feeParameters: Readonly<Record<string, string>>;
  readonly status: ChainTransactionStatus;
  readonly computeUsed: bigint | null;
  readonly feePaidInNativeUnits: bigint | null;
  readonly blockHeight: bigint | null;
  readonly failureReason: string | null;
  readonly submittedAt: Date;
  readonly confirmedAt: Date | null;
}

interface SettlementRow {
  readonly id: string;
  readonly payment_id: string;
  readonly merchant_id: string;
  readonly environment: Environment;
  readonly network_identifier: NetworkIdentifier;
  readonly source_account: string;
  readonly destination_account: string;
  readonly asset_reference: string;
  readonly amount: string;
  readonly status: SettlementStatus;
  readonly status_version: number;
  readonly attempt_count: number;
  readonly failure_reason: string | null;
  readonly settled_at: Date | null;
  readonly created_at: Date;
}

interface ChainTransactionRow {
  readonly id: string;
  readonly settlement_id: string;
  readonly network_identifier: NetworkIdentifier;
  readonly purpose: ChainTransactionPurpose;
  readonly source_account: string;
  readonly destination_account: string;
  readonly sequence_number: string;
  readonly transaction_reference: string;
  readonly value_in_native_units: string;
  readonly maximum_fee_in_native_units: string;
  readonly fee_parameters: Record<string, string>;
  readonly status: ChainTransactionStatus;
  readonly compute_used: string | null;
  readonly fee_paid_in_native_units: string | null;
  readonly block_height: string | null;
  readonly failure_reason: string | null;
  readonly submitted_at: Date;
  readonly confirmed_at: Date | null;
}

const SETTLEMENT_COLUMNS = `id, payment_id, merchant_id, environment, network_identifier,
  source_account, destination_account, asset_reference, amount, status, status_version,
  attempt_count, failure_reason, settled_at, created_at`;

const TRANSACTION_COLUMNS = `id, settlement_id, network_identifier, purpose, source_account,
  destination_account, sequence_number, transaction_reference, value_in_native_units,
  maximum_fee_in_native_units, fee_parameters, status, compute_used, fee_paid_in_native_units,
  block_height, failure_reason, submitted_at, confirmed_at`;

function toSettlement(row: SettlementRow): Settlement {
  return Object.freeze({
    identifier: row.id,
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    environment: row.environment,
    networkIdentifier: row.network_identifier,
    sourceAccount: row.source_account,
    destinationAccount: row.destination_account,
    assetReference: row.asset_reference,
    // NUMERIC arrives as a string so nothing is rounded on the way in. BigInt is the only safe parse.
    amountInBaseUnits: BigInt(row.amount),
    status: row.status,
    statusVersion: row.status_version,
    attemptCount: row.attempt_count,
    failureReason: row.failure_reason,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  });
}

function toChainTransaction(row: ChainTransactionRow): ChainTransaction {
  return Object.freeze({
    identifier: row.id,
    settlementId: row.settlement_id,
    networkIdentifier: row.network_identifier,
    purpose: row.purpose,
    sourceAccount: row.source_account,
    destinationAccount: row.destination_account,
    sequenceNumber: Number(row.sequence_number),
    transactionReference: row.transaction_reference,
    valueInNativeUnits: BigInt(row.value_in_native_units),
    maximumFeeInNativeUnits: BigInt(row.maximum_fee_in_native_units),
    feeParameters: Object.freeze({ ...row.fee_parameters }),
    status: row.status,
    computeUsed: row.compute_used === null ? null : BigInt(row.compute_used),
    feePaidInNativeUnits:
      row.fee_paid_in_native_units === null ? null : BigInt(row.fee_paid_in_native_units),
    blockHeight: row.block_height === null ? null : BigInt(row.block_height),
    failureReason: row.failure_reason,
    submittedAt: row.submitted_at,
    confirmedAt: row.confirmed_at,
  });
}

export interface TreasuryRecord {
  readonly networkIdentifier: NetworkIdentifier;
  readonly environment: Environment;
  readonly account: string;
  readonly balanceInNativeUnits: bigint | null;
  readonly observedAt: Date | null;
}

export interface PayoutDestinationRecord {
  readonly networkIdentifier: NetworkIdentifier;
  readonly account: string;
  readonly updatedAt: Date;
}

/** A payment whose funds are sitting in an address this system controls and could be moved. */
export interface SettleablePayment {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly depositAccount: string;
  readonly derivationIndex: number;
  readonly assetReference: string;
}

export interface PlanSettlementInput {
  readonly identifier: string;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly networkIdentifier: NetworkIdentifier;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly assetReference: string;
  readonly amountInBaseUnits: bigint;
}

export interface RecordBroadcastInput {
  readonly identifier: string;
  readonly settlementId: string;
  readonly networkIdentifier: NetworkIdentifier;
  readonly purpose: ChainTransactionPurpose;
  readonly sourceAccount: string;
  readonly destinationAccount: string;
  readonly sequenceNumber: number;
  readonly transactionReference: string;
  readonly valueInNativeUnits: bigint;
  readonly maximumFeeInNativeUnits: bigint;
  readonly feeParameters: Readonly<Record<string, string>>;
  /** The settlement status this broadcast moves the settlement into, applied in the same write. */
  readonly settlementStatus: SettlementStatus;
  readonly expectedStatusVersion: number;
}

export class SettlementRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Creates the settlement, or returns the one that already exists.
   *
   * Deliberately not an upsert that overwrites. A second planning attempt for a payment whose
   * settlement is already in flight must observe the first one rather than replace it, because the
   * amount and destination it would write may be a snapshot taken before the sweep it is about to
   * duplicate.
   */
  async planIfAbsent(input: PlanSettlementInput): Promise<Settlement> {
    const inserted = await this.pool.query<SettlementRow>(
      `INSERT INTO settlements
         (id, payment_id, merchant_id, environment, network_identifier, source_account,
          destination_account, asset_reference, amount)
       VALUES ($1,$2,$3,$4::environment_name,$5::network_identifier,$6,$7,$8,$9::numeric)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING ${SETTLEMENT_COLUMNS}`,
      [
        input.identifier,
        input.paymentId,
        input.merchantId,
        input.environment,
        input.networkIdentifier,
        input.sourceAccount,
        input.destinationAccount,
        input.assetReference,
        input.amountInBaseUnits.toString(),
      ],
    );

    const created = inserted.rows[0];
    if (created !== undefined) {
      return toSettlement(created);
    }

    const existing = await this.pool.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements WHERE payment_id = $1`,
      [input.paymentId],
    );
    const found = existing.rows[0];
    if (found === undefined) {
      throw new Error(`Settlement for ${input.paymentId} vanished between insert and read`);
    }
    return toSettlement(found);
  }

  async findByPayment(paymentId: string): Promise<Settlement | null> {
    const result = await this.pool.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements WHERE payment_id = $1`,
      [paymentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSettlement(row);
  }

  async findById(identifier: string): Promise<Settlement | null> {
    const result = await this.pool.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements WHERE id = $1`,
      [identifier],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSettlement(row);
  }

  /** Work waiting on this network, oldest first, so a backlog drains in the order it accrued. */
  async findUnfinished(
    networkIdentifier: NetworkIdentifier,
    limit: number,
  ): Promise<readonly Settlement[]> {
    const result = await this.pool.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
        WHERE network_identifier = $1::network_identifier
          AND status <> 'settled' AND status <> 'failed'
        ORDER BY created_at
        LIMIT $2`,
      [networkIdentifier, limit],
    );
    return result.rows.map((row) => toSettlement(row));
  }

  async transactionsFor(settlementId: string): Promise<readonly ChainTransaction[]> {
    const result = await this.pool.query<ChainTransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM chain_transactions
        WHERE settlement_id = $1 ORDER BY submitted_at`,
      [settlementId],
    );
    return result.rows.map((row) => toChainTransaction(row));
  }

  async unresolvedTransactions(
    networkIdentifier: NetworkIdentifier,
  ): Promise<readonly ChainTransaction[]> {
    const result = await this.pool.query<ChainTransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM chain_transactions
        WHERE network_identifier = $1::network_identifier
          AND (status = 'submitted' OR status = 'confirming')
        ORDER BY submitted_at`,
      [networkIdentifier],
    );
    return result.rows.map((row) => toChainTransaction(row));
  }

  /**
   * Claims the next sequence number for an account.
   *
   * The row lock serialises workers and the chain's own count corrects the stored value. Trusting
   * only the stored counter breaks the moment anyone sends from the treasury outside this system;
   * trusting only the chain hands the same number to two workers that ask before either has landed.
   * Taking the larger of the two is the only version that survives both.
   */
  async claimSequenceNumber(
    networkIdentifier: NetworkIdentifier,
    account: string,
    observedChainSequence: number,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO chain_accounts (network_identifier, account, next_sequence_number)
         VALUES ($1::network_identifier, $2, 0)
         ON CONFLICT (network_identifier, account) DO NOTHING`,
        [networkIdentifier, account],
      );

      const locked = await client.query<{ next_sequence_number: string }>(
        `SELECT next_sequence_number FROM chain_accounts
          WHERE network_identifier = $1::network_identifier AND account = $2
          FOR UPDATE`,
        [networkIdentifier, account],
      );
      const stored = Number(locked.rows[0]?.next_sequence_number ?? '0');
      const claimed = Math.max(stored, observedChainSequence);

      await client.query(
        `UPDATE chain_accounts SET next_sequence_number = $3, updated_at = now()
          WHERE network_identifier = $1::network_identifier AND account = $2`,
        [networkIdentifier, account, claimed + 1],
      );
      await client.query('COMMIT');
      return claimed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Hands a claimed sequence number back, when nothing was ever sent with it.
   *
   * A number that is claimed and then not used is a hole in the account's sequence, and a hole is
   * not a gap the chain forgives: every later transaction from that account waits behind the missing
   * one for ever. The account stops being able to send at all, which for the treasury means every
   * settlement on the network stops.
   *
   * Only the exact number just taken is returned, and only if nobody has claimed past it. That makes
   * a concurrent claim safe: the release simply does nothing, and the number stays spent rather than
   * being handed to two writers.
   */
  async releaseSequenceNumber(
    networkIdentifier: NetworkIdentifier,
    account: string,
    claimed: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE chain_accounts
          SET next_sequence_number = $3, updated_at = now()
        WHERE network_identifier = $1::network_identifier
          AND account = $2
          AND next_sequence_number = $3 + 1`,
      [networkIdentifier, account, claimed],
    );
  }

  /**
   * Records a broadcast and moves the settlement, in one transaction.
   *
   * The row must exist before the transaction is submitted, not after. A submission that times out
   * leaves no answer about whether it reached a node, and the only way to find out later is to have
   * written down what to ask about.
   */
  async recordBroadcast(input: RecordBroadcastInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const moved = await client.query(
        `UPDATE settlements
            SET status = $3::settlement_status,
                status_version = status_version + 1,
                attempt_count = attempt_count + 1,
                failure_reason = NULL,
                updated_at = now()
          WHERE id = $1 AND status_version = $2`,
        [input.settlementId, input.expectedStatusVersion, input.settlementStatus],
      );
      if (moved.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO chain_transactions
           (id, settlement_id, network_identifier, purpose, source_account, destination_account,
            sequence_number, transaction_reference, value_in_native_units,
            maximum_fee_in_native_units, fee_parameters)
         VALUES ($1,$2,$3::network_identifier,$4::chain_transaction_purpose,$5,$6,$7,$8,
                 $9::numeric,$10::numeric,$11::jsonb)`,
        [
          input.identifier,
          input.settlementId,
          input.networkIdentifier,
          input.purpose,
          input.sourceAccount,
          input.destinationAccount,
          input.sequenceNumber,
          input.transactionReference,
          input.valueInNativeUnits.toString(),
          input.maximumFeeInNativeUnits.toString(),
          JSON.stringify(input.feeParameters),
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

  async markTransactionResolved(
    identifier: string,
    status: ChainTransactionStatus,
    outcome: {
      readonly computeUsed?: bigint;
      readonly feePaidInNativeUnits?: bigint;
      readonly blockHeight?: bigint;
      readonly blockReference?: string;
      readonly failureReason?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE chain_transactions
          SET status = $2::chain_transaction_status,
              compute_used = COALESCE($3, compute_used),
              fee_paid_in_native_units = COALESCE($4::numeric, fee_paid_in_native_units),
              block_height = COALESCE($5, block_height),
              block_reference = COALESCE($6, block_reference),
              failure_reason = COALESCE($7, failure_reason),
              confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        identifier,
        status,
        outcome.computeUsed?.toString() ?? null,
        outcome.feePaidInNativeUnits?.toString() ?? null,
        outcome.blockHeight?.toString() ?? null,
        outcome.blockReference ?? null,
        outcome.failureReason ?? null,
      ],
    );
  }

  /**
   * Moves a settlement, refusing an edge the state machine does not declare and refusing a write
   * that lost a race. Both checks are needed: the first stops a wrong transition, the second stops
   * a right transition applied to state that has already moved on.
   */
  async saveStatus(
    identifier: string,
    from: SettlementStatus,
    to: SettlementStatus,
    expectedStatusVersion: number,
    failureReason: string | null,
  ): Promise<boolean> {
    if (!canTransitionSettlement(from, to)) {
      throw new Error(`A settlement cannot move from ${from} to ${to}`);
    }

    const result = await this.pool.query(
      `UPDATE settlements
          SET status = $4::settlement_status,
              status_version = status_version + 1,
              failure_reason = $5,
              settled_at = CASE WHEN $4 = 'settled' THEN now() ELSE settled_at END,
              updated_at = now()
        WHERE id = $1 AND status = $2::settlement_status AND status_version = $3`,
      [identifier, from, expectedStatusVersion, to, failureReason],
    );
    return result.rowCount === 1;
  }

  /**
   * Everything the treasury has committed on this network. Read as one aggregate rather than as a
   * running total kept in a column, because a total maintained beside the rows it counts is a second
   * write that can disagree with them, and the disagreement is discovered by overspending.
   */
  async treasurySpends(
    networkIdentifier: NetworkIdentifier,
    treasuryAccount: string,
  ): Promise<readonly TreasurySpend[]> {
    const result = await this.pool.query<{
      value_in_native_units: string;
      maximum_fee_in_native_units: string;
      fee_paid_in_native_units: string | null;
    }>(
      `SELECT value_in_native_units, maximum_fee_in_native_units, fee_paid_in_native_units
         FROM chain_transactions
        WHERE network_identifier = $1::network_identifier
          AND source_account = $2
          AND status <> 'replaced'
          AND status <> 'dropped'`,
      [networkIdentifier, treasuryAccount],
    );

    return result.rows.map((row) => ({
      valueInNativeUnits: BigInt(row.value_in_native_units),
      maximumFeeInNativeUnits: BigInt(row.maximum_fee_in_native_units),
      feePaidInNativeUnits:
        row.fee_paid_in_native_units === null ? null : BigInt(row.fee_paid_in_native_units),
    }));
  }

  /**
   * Every finished payment whose deposit address no settlement has claimed yet.
   *
   * Deliberately every terminal status, not only the two that mean the customer paid in full. A
   * deposit address is derived for one invoice and used once, so anything left in it after the
   * payment finishes is unreachable by any other part of this system: an underpayment, a transfer
   * that arrived seconds after the window closed, or a transfer that landed against a payment the
   * merchant had just cancelled. Leaving those where they are does not preserve anyone's options; it
   * strands real money at an address nobody will ever look at again.
   *
   * Sweeping does not decide what happens to the money. It moves it to the merchant's payout
   * account, where a refund is a transaction they can make and where their accounting can see it.
   * The alternative is a balance that only a manual key derivation could ever recover.
   *
   * Nothing is swept on the strength of this query alone: the caller reads the on-chain balance and
   * skips an address holding nothing, so a payment that expired unpaid — the overwhelming majority —
   * costs one balance read and no transaction.
   */
  async findSettleablePayments(
    networkIdentifier: NetworkIdentifier,
    limit: number,
  ): Promise<readonly SettleablePayment[]> {
    const result = await this.pool.query<{
      payment_id: string;
      merchant_id: string;
      environment: Environment;
      account: string;
      derivation_index: number;
      asset_reference: string;
    }>(
      `SELECT p.id AS payment_id, p.merchant_id, p.environment,
              a.account, a.derivation_index, p.asset_reference
         FROM payments p
         JOIN payment_addresses a ON a.payment_id = p.id
         LEFT JOIN settlements s ON s.payment_id = p.id
        WHERE p.network_identifier = $1::network_identifier
          AND p.status IN ('completed', 'overpaid', 'underpaid', 'expired', 'canceled')
          AND s.id IS NULL
        ORDER BY p.created_at
        LIMIT $2`,
      [networkIdentifier, limit],
    );

    return result.rows.map((row) => ({
      paymentId: row.payment_id,
      merchantId: row.merchant_id,
      environment: row.environment,
      depositAccount: row.account,
      derivationIndex: row.derivation_index,
      assetReference: row.asset_reference,
    }));
  }

  async derivationIndexFor(paymentId: string): Promise<number | null> {
    const result = await this.pool.query<{ derivation_index: number }>(
      'SELECT derivation_index FROM payment_addresses WHERE payment_id = $1',
      [paymentId],
    );
    return result.rows[0]?.derivation_index ?? null;
  }

  /**
   * Failed settlements whose backoff has elapsed and whose attempts are not spent.
   *
   * `updated_at` carries the backoff rather than a column of its own: every write to a settlement
   * touches it, so the clock restarts on the last thing that actually happened rather than on a
   * schedule computed when the failure was recorded.
   */
  async findRetryable(
    networkIdentifier: NetworkIdentifier,
    maximumAttempts: number,
    backoffMilliseconds: number,
    limit: number,
  ): Promise<readonly Settlement[]> {
    const result = await this.pool.query<SettlementRow>(
      // The cutoff is computed by the database, against the same clock that wrote updated_at. A
      // timestamp built in the process is a few milliseconds off from the server's, which is enough
      // for a zero backoff to select nothing at all and for a retry to look broken.
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
        WHERE network_identifier = $1::network_identifier
          AND status = 'failed'
          AND attempt_count < $2
          AND updated_at <= now() - make_interval(secs => $3::double precision / 1000)
        ORDER BY updated_at
        LIMIT $4`,
      [networkIdentifier, maximumAttempts, backoffMilliseconds, limit],
    );
    return result.rows.map((row) => toSettlement(row));
  }

  /**
   * Records the treasury address and what it was last seen holding.
   *
   * Written by the settlement worker, which is the only process that can derive the address, and
   * read by the API, which must never be able to. The balance carries the moment it was observed
   * because that is what it is: a reading, not a live figure.
   */
  async recordTreasury(
    networkIdentifier: NetworkIdentifier,
    environment: Environment,
    account: string,
    balanceInNativeUnits: bigint | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO treasury_accounts
         (network_identifier, environment, account, balance_in_native_units, observed_at)
       VALUES ($1::network_identifier, $2::environment_name, $3, $4::numeric,
               CASE WHEN $4 IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (network_identifier) DO UPDATE
         SET environment = EXCLUDED.environment,
             account = EXCLUDED.account,
             balance_in_native_units =
               COALESCE(EXCLUDED.balance_in_native_units, treasury_accounts.balance_in_native_units),
             observed_at = COALESCE(EXCLUDED.observed_at, treasury_accounts.observed_at),
             updated_at = now()`,
      [
        networkIdentifier,
        environment,
        account,
        balanceInNativeUnits === null ? null : balanceInNativeUnits.toString(),
      ],
    );
  }

  async findTreasuries(): Promise<readonly TreasuryRecord[]> {
    const result = await this.pool.query<{
      network_identifier: NetworkIdentifier;
      environment: Environment;
      account: string;
      balance_in_native_units: string | null;
      observed_at: Date | null;
    }>(
      `SELECT network_identifier, environment, account, balance_in_native_units, observed_at
         FROM treasury_accounts`,
    );
    return result.rows.map((row) => ({
      networkIdentifier: row.network_identifier,
      environment: row.environment,
      account: row.account,
      balanceInNativeUnits:
        row.balance_in_native_units === null ? null : BigInt(row.balance_in_native_units),
      observedAt: row.observed_at,
    }));
  }

  /** Settlements for one merchant and environment, newest first. */
  async listForMerchant(
    merchantId: string,
    environment: Environment,
    limit: number,
  ): Promise<readonly Settlement[]> {
    const result = await this.pool.query<SettlementRow>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM settlements
        WHERE merchant_id = $1 AND environment = $2::environment_name
        ORDER BY created_at DESC
        LIMIT $3`,
      [merchantId, environment, limit],
    );
    return result.rows.map((row) => toSettlement(row));
  }

  async findPayoutDestinations(
    merchantId: string,
    environment: Environment,
  ): Promise<readonly PayoutDestinationRecord[]> {
    const result = await this.pool.query<{
      network_identifier: NetworkIdentifier;
      account: string;
      updated_at: Date;
    }>(
      `SELECT network_identifier, account, updated_at FROM payout_destinations
        WHERE merchant_id = $1 AND environment = $2::environment_name
        ORDER BY network_identifier`,
      [merchantId, environment],
    );
    return result.rows.map((row) => ({
      networkIdentifier: row.network_identifier,
      account: row.account,
      updatedAt: row.updated_at,
    }));
  }

  async payoutDestinationFor(
    merchantId: string,
    environment: Environment,
    networkIdentifier: NetworkIdentifier,
  ): Promise<string | null> {
    const result = await this.pool.query<{ account: string }>(
      `SELECT account FROM payout_destinations
        WHERE merchant_id = $1 AND environment = $2::environment_name
          AND network_identifier = $3::network_identifier`,
      [merchantId, environment, networkIdentifier],
    );
    return result.rows[0]?.account ?? null;
  }

  async setPayoutDestination(
    merchantId: string,
    environment: Environment,
    networkIdentifier: NetworkIdentifier,
    account: string,
    client?: PoolClient,
  ): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO payout_destinations (merchant_id, environment, network_identifier, account)
       VALUES ($1,$2::environment_name,$3::network_identifier,$4)
       ON CONFLICT (merchant_id, environment, network_identifier)
       DO UPDATE SET account = EXCLUDED.account, updated_at = now()`,
      [merchantId, environment, networkIdentifier, account],
    );
  }
}
