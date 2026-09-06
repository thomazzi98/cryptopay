import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

import { applyMigrations } from '../../src/infrastructure/persistence/migrate.js';
import { Pool } from 'pg';

/**
 * Integration tests run against a real PostgreSQL server, started as a native binary rather than a
 * container. A ledger whose correctness rests on partial unique indexes, SKIP LOCKED and
 * compare-and-swap must be tested against the same engine it will run on, and requiring a container
 * daemon would make the suite unrunnable on a machine that does not have one.
 *
 * Migrations are applied once into a template database. Each test file then creates its own database
 * from that template, which PostgreSQL implements as a file copy: full isolation for tens of
 * milliseconds, with no cross-test cleanup to forget.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIRECTORY = resolve(packageRoot, 'node_modules/.cache/cryptopay-postgres');
const MIGRATIONS_DIRECTORY = resolve(packageRoot, 'migrations');

export const TEMPLATE_DATABASE = 'cryptopay_template';
export const POSTGRES_USER = 'cryptopay';
export const POSTGRES_PASSWORD = 'cryptopay';

function readPort(): number {
  const configured = process.env.TEST_POSTGRES_PORT;
  if (configured === undefined) {
    return 55_433;
  }
  return Number(configured);
}

export function connectionUrlFor(databaseName: string, port: number): string {
  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${databaseName}`;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = readPort();

  // A previous run that was killed rather than stopped leaves a data directory behind. Reusing it
  // would silently inherit its schema, so the directory is always rebuilt.
  await rm(DATA_DIRECTORY, { recursive: true, force: true });

  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIRECTORY,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    port,
    persistent: false,
  });

  await server.initialise();
  await server.start();
  await server.createDatabase(TEMPLATE_DATABASE);

  const pool = new Pool({ connectionString: connectionUrlFor(TEMPLATE_DATABASE, port) });
  try {
    await applyMigrations(pool, MIGRATIONS_DIRECTORY);
  } finally {
    await pool.end();
  }

  project.provide('postgresPort', port);

  return async () => {
    await server.stop();
    await rm(DATA_DIRECTORY, { recursive: true, force: true });
  };
}

/**
 * Creates a throwaway database from the migrated template and returns a pool onto it, plus the
 * teardown that drops it.
 */
export async function createIsolatedDatabase(
  port: number,
  label: string,
): Promise<{ pool: Pool; databaseName: string; drop: () => Promise<void> }> {
  const databaseName = `cryptopay_test_${label}`;
  const administrative = new Client({ connectionString: connectionUrlFor('postgres', port) });
  await administrative.connect();
  await administrative.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await administrative.query(`CREATE DATABASE ${databaseName} TEMPLATE ${TEMPLATE_DATABASE}`);
  await administrative.end();

  const pool = new Pool({ connectionString: connectionUrlFor(databaseName, port) });

  return {
    pool,
    databaseName,
    drop: async () => {
      await pool.end();
      const cleanup = new Client({ connectionString: connectionUrlFor('postgres', port) });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await cleanup.end();
    },
  };
}
