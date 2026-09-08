import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  applyMigrations,
  MigrationChecksumError,
  readSchemaVersion,
} from '../src/infrastructure/persistence/migrate.js';
import { createIsolatedDatabase } from './setup/postgres.global-setup.js';

let pool: Pool;
let dropDatabase: () => Promise<void>;
let migrationsDirectory: string;

beforeAll(async () => {
  const isolated = await createIsolatedDatabase(inject('postgresPort'), 'migrations');
  pool = isolated.pool;
  dropDatabase = isolated.drop;
  migrationsDirectory = await mkdtemp(join(tmpdir(), 'cryptopay-migrations-'));
});

afterAll(async () => {
  await dropDatabase();
  await rm(migrationsDirectory, { recursive: true, force: true });
});

async function writeMigration(name: string, sql: string): Promise<void> {
  await writeFile(join(migrationsDirectory, name), sql, 'utf8');
}

describe('applyMigrations', () => {
  it('applies a new migration once and reports it as applied', async () => {
    await writeMigration('9001_probe.sql', 'CREATE TABLE probe_one (id TEXT PRIMARY KEY);');

    const first = await applyMigrations(pool, migrationsDirectory);
    expect(first).toHaveLength(1);
    expect(first[0]?.alreadyApplied).toBe(false);

    const second = await applyMigrations(pool, migrationsDirectory);
    expect(second[0]?.alreadyApplied).toBe(true);
  });

  it('applies migrations in filename order', async () => {
    await writeMigration(
      '9002_probe.sql',
      'CREATE TABLE probe_two (id TEXT PRIMARY KEY REFERENCES probe_one (id));',
    );
    const applied = await applyMigrations(pool, migrationsDirectory);
    expect(applied.map((migration) => migration.name)).toStrictEqual([
      '9001_probe.sql',
      '9002_probe.sql',
    ]);
  });

  // Numbered far above the real migrations on purpose. The isolated database is cloned from the
  // migrated template, so the schema version is the newest name across both sets, and probes numbered
  // alongside the real ones would make this assertion pass or fail on how many migrations exist.
  it('reports the newest migration as the schema version', async () => {
    expect(await readSchemaVersion(pool)).toBe('9002_probe.sql');
  });

  // Editing a shipped migration otherwise surfaces as an environment behaving differently from its
  // schema, which is a far more expensive way to discover the same mistake.
  it('refuses to run when an applied migration has been edited', async () => {
    await writeMigration(
      '9001_probe.sql',
      'CREATE TABLE probe_one (id TEXT PRIMARY KEY, extra TEXT);',
    );
    await expect(applyMigrations(pool, migrationsDirectory)).rejects.toThrow(
      MigrationChecksumError,
    );
  });

  it('names the offending migration in the error', async () => {
    await expect(applyMigrations(pool, migrationsDirectory)).rejects.toThrow(/9001_probe\.sql/);
  });

  it('rolls a failing migration back rather than half-applying it', async () => {
    await writeMigration('9001_probe.sql', 'CREATE TABLE probe_one (id TEXT PRIMARY KEY);');
    await writeMigration(
      '9003_broken.sql',
      'CREATE TABLE probe_three (id TEXT PRIMARY KEY); CREATE TABLE probe_three (id TEXT);',
    );

    await expect(applyMigrations(pool, migrationsDirectory)).rejects.toThrow();

    const table = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM information_schema.tables WHERE table_name = 'probe_three'",
    );
    expect(table.rows[0]?.count).toBe('0');

    const recorded = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM schema_migrations WHERE name = '9003_broken.sql'",
    );
    expect(recorded.rows[0]?.count).toBe('0');
  });

  it('ignores files that are not numbered migrations', async () => {
    await rm(join(migrationsDirectory, '9003_broken.sql'));
    await writeMigration('README.md', 'not a migration');
    await writeMigration('draft.sql', 'CREATE TABLE never_created (id TEXT);');

    const applied = await applyMigrations(pool, migrationsDirectory);
    expect(applied.map((migration) => migration.name)).toStrictEqual([
      '9001_probe.sql',
      '9002_probe.sql',
    ]);
  });
});
