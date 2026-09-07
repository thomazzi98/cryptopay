import type { Environment } from '@cryptopay/shared';
import { generateSigningSecret } from '@cryptopay/shared/server';
import type { Pool } from 'pg';

/**
 * The secrets a merchant verifies callbacks with.
 *
 * Rotation is by overlap rather than by replacement: a new secret is added, both sign for a grace
 * period, and the old one is retired once the merchant has adopted the new one. Replacing outright
 * breaks every endpoint that has not been updated yet, at the exact moment the merchant is least able
 * to tell why.
 */

export interface WebhookSecret {
  readonly identifier: string;
  readonly secret: string;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

interface SecretRow {
  readonly id: string;
  readonly secret: string;
  readonly created_at: Date;
  readonly retired_at: Date | null;
}

export class WebhookSecretRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Newest first, which is the order they are presented in the signature header. */
  async activeSecrets(
    merchantId: string,
    environment: Environment,
  ): Promise<readonly WebhookSecret[]> {
    const result = await this.pool.query<SecretRow>(
      `SELECT id, secret, created_at, retired_at FROM webhook_secrets
        WHERE merchant_id = $1 AND environment = $2::environment_name AND retired_at IS NULL
        ORDER BY created_at DESC`,
      [merchantId, environment],
    );
    return result.rows.map((row) =>
      Object.freeze({
        identifier: row.id,
        secret: row.secret,
        createdAt: row.created_at,
        retiredAt: row.retired_at,
      }),
    );
  }

  async issue(identifier: string, merchantId: string, environment: Environment): Promise<string> {
    const secret = generateSigningSecret();
    await this.pool.query(
      `INSERT INTO webhook_secrets (id, merchant_id, environment, secret)
       VALUES ($1, $2, $3::environment_name, $4)`,
      [identifier, merchantId, environment, secret],
    );
    return secret;
  }

  /**
   * Ends a rotation. Refuses to retire the last active secret, because a merchant with none would
   * receive callbacks nobody can verify, which is worse than a stale secret still working.
   */
  async retire(identifier: string, merchantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE webhook_secrets target
          SET retired_at = now()
        WHERE target.id = $1
          AND target.merchant_id = $2
          AND target.retired_at IS NULL
          AND EXISTS (
            SELECT 1 FROM webhook_secrets sibling
             WHERE sibling.merchant_id = target.merchant_id
               AND sibling.environment = target.environment
               AND sibling.retired_at IS NULL
               AND sibling.id <> target.id
          )`,
      [identifier, merchantId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
