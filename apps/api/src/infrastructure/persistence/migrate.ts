import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

/**
 * Applies plain SQL migrations in filename order, once each, inside a transaction.
 *
 * Migrations are SQL rather than a schema-language model because every safety property this system
 * relies on lives in features a model cannot express: partial unique indexes, CHECK constraints,
 * sequences and role grants. A model would be a partial copy of the real schema, and the copy would
 * drift. Here the file that runs is the file a reviewer reads.
 *
 * Each applied migration's checksum is recorded. Editing a migration that has already run is a
 * mistake that otherwise surfaces as an environment behaving differently from its schema, so it is
 * refused loudly instead.
 */

const MIGRATION_ADVISORY_LOCK_KEY = 8_274_913_055_120n;
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z\d_]+\.sql$/;

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly alreadyApplied: boolean;
}

export class MigrationChecksumError extends Error {
  constructor(name: string, recorded: string, current: string) {
    super(
      `Migration ${name} has changed since it was applied (recorded ${recorded}, now ${current}). ` +
        'Applied migrations are immutable: add a new migration instead of editing this one.',
    );
    this.name = 'MigrationChecksumError';
  }
}

/**
 * Ordering is by code unit rather than locale. Migration order decides schema correctness, and
 * localeCompare would let a machine's locale settings change the order files are applied in.
 */
function byFilename(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function checksumOf(sql: string): string {
  // Line endings are normalised so a checkout on Windows and one on Linux agree.
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

async function readMigrationFiles(
  directory: string,
): Promise<readonly { name: string; sql: string }[]> {
  const entries = await readdir(directory);
  const names = entries.filter((entry) => MIGRATION_FILE_PATTERN.test(entry)).toSorted(byFilename);

  const files = [];
  for (const name of names) {
    files.push({ name, sql: await readFile(join(directory, name), 'utf8') });
  }
  return files;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readRecordedChecksums(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function applyOne(client: PoolClient, name: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      name,
      checksumOf(sql),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * The advisory lock is session-scoped and held only for the duration of migration, so two instances
 * starting at once cannot apply the same file twice. This is the one place a session-level advisory
 * lock is correct: the running system elects its singleton loops through leased leadership instead,
 * because a lock has no failover when a process hangs while staying connected.
 */
export async function applyMigrations(
  pool: Pool,
  migrationsDirectory: string,
): Promise<readonly AppliedMigration[]> {
  const files = await readMigrationFiles(migrationsDirectory);
  const client = await pool.connect();
  const applied: AppliedMigration[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    await ensureMigrationTable(client);
    const recorded = await readRecordedChecksums(client);

    for (const file of files) {
      const checksum = checksumOf(file.sql);
      const previous = recorded.get(file.name);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new MigrationChecksumError(file.name, previous, checksum);
        }
        applied.push({ name: file.name, checksum, alreadyApplied: true });
        continue;
      }

      await applyOne(client, file.name, file.sql);
      applied.push({ name: file.name, checksum, alreadyApplied: false });
    }

    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    client.release();
  }
}

/** The migration the running binary expects, reported by the readiness endpoint. */
export async function readSchemaVersion(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  );
  return result.rows[0]?.name ?? null;
}
