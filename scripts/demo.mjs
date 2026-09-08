#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';

/**
 * The whole system, running locally, with one command and no Docker.
 *
 * Docker Compose is the deployment shape and is what `docker compose up` gives you. This is the
 * other thing a person wants: a way to look at the interface in a browser thirty seconds after
 * cloning, on a machine where the virtualisation stack is unavailable or simply not worth waiting
 * for.
 *
 * Every credential here is generated for this run and discarded with the process. Nothing is read
 * from .env and nothing is written to it, so running this cannot disturb a real configuration or
 * leave a secret behind on disk.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');
const dataDirectory = mkdtempSync(join(tmpdir(), 'cryptopay-demo-'));

/**
 * A port the operating system will actually hand over.
 *
 * Choosing one at random is not enough on Windows: enabling Hyper-V reserves whole ranges, and a
 * port inside one fails to bind with "permission denied" rather than "in use", which reads like a
 * privileges problem and is not one. Asking the kernel for an ephemeral port and then releasing it
 * is the only check that accounts for that.
 */
async function findBindablePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

const credentials = {
  apiKeyPepper: randomBytes(36).toString('base64'),
  walletKeyEncryptionKey: randomBytes(32).toString('base64'),
};

const children = [];
const running = { postgres: null };

async function shutDown(code) {
  for (const child of children) {
    child.kill();
  }
  if (running.postgres !== null) {
    try {
      await running.postgres.stop();
    } catch {
      // Already gone, which is the ordinary case when this runs after a failure.
    }
  }
  rmSync(dataDirectory, { recursive: true, force: true });
  process.exit(code);
}

process.on('SIGINT', () => void shutDown(0));
process.on('SIGTERM', () => void shutDown(0));

function run(command, argumentList, extraEnvironment) {
  const child = spawn(command, argumentList, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  children.push(child);
  return child;
}

function runToCompletion(command, argumentList, extraEnvironment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = run(command, argumentList, extraEnvironment);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} exited with ${String(code)}`));
    });
  });
}

/** Polls the endpoint rather than sleeping, because a fixed wait is wrong on every machine but one. */
async function waitForHealth(url, name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet, which is the expected answer for the first second or so.
    }
    await new Promise((sleep) => setTimeout(sleep, 500));
  }
  throw new Error(`${name} did not become healthy`);
}

async function main() {
  const databasePort = await findBindablePort();

  console.log('Starting PostgreSQL...');
  running.postgres = new EmbeddedPostgres({
    databaseDir: dataDirectory,
    user: 'cryptopay',
    password: 'cryptopay_demo',
    port: databasePort,
    persistent: false,
  });
  await running.postgres.initialise();
  await running.postgres.start();
  await running.postgres.createDatabase('cryptopay');

  const databaseUrl = `postgresql://cryptopay:cryptopay_demo@127.0.0.1:${String(databasePort)}/cryptopay`;
  const serviceEnvironment = {
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl,
    API_KEY_PEPPER: credentials.apiKeyPepper,
    WALLET_KEY_ENCRYPTION_KEY: credentials.walletKeyEncryptionKey,
    PUBLIC_CHECKOUT_BASE_URL: 'http://localhost:3000/pay',
  };

  console.log('Applying migrations...');
  await runToCompletion(
    'node',
    ['apps/api/dist/infrastructure/persistence/migrate-cli.js'],
    serviceEnvironment,
  );

  console.log('Provisioning a wallet seed...');
  await runToCompletion(
    'node',
    ['apps/api/dist/infrastructure/wallet/provision-seed-cli.js', 'test'],
    serviceEnvironment,
  );

  console.log('Seeding a merchant and an API key...');
  const pool = new Pool({ connectionString: databaseUrl });
  const { generateApiKey } = await import(
    `file://${join(repositoryRoot, 'apps/api/dist/infrastructure/crypto/api-key.js')}`
  );
  const { UlidFactory } = await import(
    `file://${join(repositoryRoot, 'apps/api/dist/infrastructure/system/ulid.js')}`
  );

  const ulidFactory = new UlidFactory();
  const merchantId = `mch_${ulidFactory.create(Date.now())}`;
  await pool.query(
    `INSERT INTO merchants (id, name, underpayment_tolerance_basis_points,
       overpayment_tolerance_basis_points, default_payment_lifetime_seconds)
     VALUES ($1, 'Northwind Supplies', 50, 100, 1800)`,
    [merchantId],
  );

  const issued = generateApiKey('test', credentials.apiKeyPepper, ulidFactory, Date.now());
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label)
     VALUES ($1, $2, 'test', $3, $4, 'demo')`,
    [issued.keyIdentifier, merchantId, issued.secretDigest, issued.lastFour],
  );

  // A cursor is required before a payment can be created: accepting money on a chain nothing is
  // scanning would leave the customer's transfer unobserved indefinitely.
  await pool.query(
    `INSERT INTO block_cursors
       (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
     VALUES ('polygon-amoy', 0, '0x0', 20)
     ON CONFLICT (network_identifier) DO NOTHING`,
  );
  await pool.end();

  console.log('Starting the API...');
  run('node', ['apps/api/dist/main.api.js'], {
    ...serviceEnvironment,
    PORT: '3001',
    HOST: '127.0.0.1',
  });
  await waitForHealth('http://127.0.0.1:3001/healthz', 'The API');

  console.log('Starting the dashboard...');
  run('npm', ['run', 'start', '--workspace', 'apps/web'], {
    NODE_ENV: 'production',
    CRYPTOPAY_API_URL: 'http://127.0.0.1:3001',
    PORT: '3000',
  });
  await waitForHealth('http://127.0.0.1:3000/connect', 'The dashboard');

  const rule = '-'.repeat(60);
  console.log(`\n${rule}`);
  console.log('  Dashboard   http://localhost:3000');
  console.log('  API         http://localhost:3001');
  console.log('');
  console.log('  Connect with this key. It exists only for this run:');
  console.log(`  ${issued.presentedKey}`);
  console.log('');
  console.log('  There is no chain worker running, so payments stay pending.');
  console.log('  Stop with Ctrl+C; the database is deleted on exit.');
  console.log(`${rule}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  await shutDown(1);
}
