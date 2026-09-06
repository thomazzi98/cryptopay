import type { Environment } from '@cryptopay/shared';
import type { Pool } from 'pg';

import type { SealedSeed } from '../wallet/master-seed.js';
import type { KeyWrappingScheme } from '../wallet/key-wrapping.js';

/**
 * Storage for the sealed master seed. The plaintext seed exists only inside the process that opened
 * it, and never in a column, a log line or an API response.
 */

interface SeedRow {
  readonly scheme: KeyWrappingScheme;
  readonly key_identifier: string;
  readonly wrapped_data_key: Buffer;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authentication_tag: Buffer;
}

export class WalletSeedRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async find(environment: Environment): Promise<SealedSeed | null> {
    const result = await this.pool.query<SeedRow>(
      `SELECT scheme, key_identifier, wrapped_data_key, nonce, ciphertext, authentication_tag
         FROM wallet_seeds WHERE environment = $1::environment_name`,
      [environment],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      scheme: row.scheme,
      keyIdentifier: row.key_identifier,
      wrappedDataKey: row.wrapped_data_key,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authenticationTag: row.authentication_tag,
    };
  }

  /**
   * Stores a seed only if the environment has none. Replacing a seed would strand every address
   * already issued from the previous one, so it is refused here rather than guarded by convention.
   */
  async storeIfAbsent(
    identifier: string,
    environment: Environment,
    sealed: SealedSeed,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO wallet_seeds
         (id, environment, scheme, key_identifier, wrapped_data_key, nonce, ciphertext, authentication_tag)
       VALUES ($1, $2::environment_name, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (environment) DO NOTHING`,
      [
        identifier,
        environment,
        sealed.scheme,
        sealed.keyIdentifier,
        sealed.wrappedDataKey,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authenticationTag,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Allocates the next derivation index for an environment from its dedicated sequence. */
  async nextDerivationIndex(environment: Environment): Promise<number> {
    const sequence =
      environment === 'live' ? 'payment_address_index_live' : 'payment_address_index_test';
    const result = await this.pool.query<{ index: string }>(
      `SELECT nextval('${sequence}') AS index`,
    );
    return Number(result.rows[0]?.index ?? 0);
  }
}
