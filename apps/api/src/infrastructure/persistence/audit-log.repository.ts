import type { Pool } from 'pg';

/**
 * What a person or an integration asked for, kept separately from what the system concluded.
 *
 * The payment status history already records what happened to a payment and why, derived from what
 * a chain showed. It says nothing about who started it. When a payment turns out to have been
 * created in error, or a key is suspected of being compromised, the question is always "which key
 * did this, and what else did that key do", and only this table can answer it.
 *
 * Writing must never fail the request that caused it. An audit trail that can refuse a payment is a
 * worse failure than one with a gap, so a write that throws is logged and swallowed. That is a
 * deliberate trade rather than an oversight, and it is why the table is not the authority on
 * anything: the payment tables are.
 */

type AuditAction =
  'payment.created' | 'payment.cancelled' | 'payment.read' | 'api_key.used' | 'api_key.refused';

export interface AuditEntry {
  readonly merchantId: string | null;
  readonly apiKeyId: string | null;
  readonly action: AuditAction;
  readonly subjectType: 'payment' | 'api_key' | 'merchant';
  readonly subjectId: string | null;
  readonly requestId: string | null;
  /**
   * Request-shaped facts only. Never a secret, never a whole request body: an audit row is read by
   * people who are not entitled to the payload, and a body can carry a callback URL with a token in
   * it.
   */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export class AuditLogRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log
         (merchant_id, api_key_id, action, subject_type, subject_id, request_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.merchantId,
        entry.apiKeyId,
        entry.action,
        entry.subjectType,
        entry.subjectId,
        entry.requestId,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  }

  /** Everything a merchant did, newest first. The shape an investigation reads. */
  async findByMerchant(merchantId: string, limit: number): Promise<readonly AuditRecord[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT occurred_at, merchant_id, api_key_id, action, subject_type, subject_id, request_id,
              detail
         FROM audit_log
        WHERE merchant_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      [merchantId, limit],
    );
    return result.rows.map((row) => toRecord(row));
  }

  /** Everything that touched one subject, which is the other question an investigation asks. */
  async findBySubject(
    subjectType: string,
    subjectId: string,
    limit: number,
  ): Promise<readonly AuditRecord[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT occurred_at, merchant_id, api_key_id, action, subject_type, subject_id, request_id,
              detail
         FROM audit_log
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY occurred_at DESC, id DESC
        LIMIT $3`,
      [subjectType, subjectId, limit],
    );
    return result.rows.map((row) => toRecord(row));
  }
}

export interface AuditRecord {
  readonly occurredAt: Date;
  readonly merchantId: string | null;
  readonly apiKeyId: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly requestId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface AuditRow {
  readonly occurred_at: Date;
  readonly merchant_id: string | null;
  readonly api_key_id: string | null;
  readonly action: string;
  readonly subject_type: string;
  readonly subject_id: string | null;
  readonly request_id: string | null;
  readonly detail: Record<string, unknown>;
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    occurredAt: row.occurred_at,
    merchantId: row.merchant_id,
    apiKeyId: row.api_key_id,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    requestId: row.request_id,
    detail: row.detail,
  };
}
