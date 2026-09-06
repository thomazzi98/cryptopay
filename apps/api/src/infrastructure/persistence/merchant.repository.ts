import type { Environment } from '@cryptopay/shared';
import type { Pool } from 'pg';

/**
 * Merchant and API key reads. Concrete rather than behind an interface: there will only ever be one
 * implementation, and the integration tests run against a real PostgreSQL, which is stronger
 * evidence than a fake could provide.
 */

export interface Merchant {
  readonly id: string;
  readonly name: string;
  readonly underpaymentToleranceBasisPoints: number;
  readonly overpaymentToleranceBasisPoints: number;
  readonly defaultPaymentLifetimeSeconds: number;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly environment: Environment;
  readonly secretDigest: Buffer;
  readonly revokedAt: Date | null;
}

interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly underpayment_tolerance_basis_points: number;
  readonly overpayment_tolerance_basis_points: number;
  readonly default_payment_lifetime_seconds: number;
}

interface ApiKeyRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly environment: Environment;
  readonly secret_digest: Buffer;
  readonly revoked_at: Date | null;
}

export class MerchantRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async findApiKey(keyIdentifier: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<ApiKeyRow>(
      `SELECT id, merchant_id, environment, secret_digest, revoked_at
         FROM api_keys WHERE id = $1`,
      [keyIdentifier],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return Object.freeze({
      id: row.id,
      merchantId: row.merchant_id,
      environment: row.environment,
      secretDigest: row.secret_digest,
      revokedAt: row.revoked_at,
    });
  }

  async findById(merchantId: string): Promise<Merchant | null> {
    const result = await this.pool.query<MerchantRow>(
      `SELECT id, name, underpayment_tolerance_basis_points, overpayment_tolerance_basis_points,
              default_payment_lifetime_seconds
         FROM merchants WHERE id = $1`,
      [merchantId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return Object.freeze({
      id: row.id,
      name: row.name,
      underpaymentToleranceBasisPoints: row.underpayment_tolerance_basis_points,
      overpaymentToleranceBasisPoints: row.overpayment_tolerance_basis_points,
      defaultPaymentLifetimeSeconds: row.default_payment_lifetime_seconds,
    });
  }

  /**
   * Recorded on a best-effort basis after a successful authentication. It is deliberately not part
   * of the request transaction: a failure to record a timestamp must never fail a payment.
   */
  async recordKeyUsage(keyIdentifier: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [
      keyIdentifier,
    ]);
  }
}
