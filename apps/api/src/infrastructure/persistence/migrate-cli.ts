import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { applyMigrations } from './migrate.js';

/**
 * Applies pending migrations against DATABASE_URL and reports what it did. Run before the API and
 * the workers start; the advisory lock inside makes it safe to run from several instances at once.
 */

const MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    process.stderr.write('DATABASE_URL is not set.\n');
    process.exit(78);
  }

  const pool = new Pool({ connectionString });
  try {
    const applied = await applyMigrations(pool, MIGRATIONS_DIRECTORY);
    for (const migration of applied) {
      const state = migration.alreadyApplied ? 'already applied' : 'applied';
      process.stdout.write(`${state.padEnd(15)} ${migration.name}\n`);
    }
    const pending = applied.filter((migration) => !migration.alreadyApplied).length;
    process.stdout.write(`\n${pending} migration(s) applied, schema is up to date.\n`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
