import { writeFile } from 'node:fs/promises';

import { isEnvironment, isNetworkIdentifier, type Environment } from '@cryptopay/shared';
import { Pool } from 'pg';

import { loadConfiguration, rpcUrlsFor } from '../../configuration.js';
import { generateApiKey } from '../crypto/api-key.js';
import { UlidFactory } from '../system/ulid.js';
import { WebhookSecretRepository } from './webhook-secret.repository.js';

/**
 * Makes an empty database usable: one merchant, one API key, and a cursor for every network that has
 * an endpoint configured.
 *
 * Without this a freshly migrated database answers every request with 401 and refuses every payment,
 * because a payment cannot be created for a network no scanner is watching. Someone has to write
 * those three rows, and leaving it to a README step means the first thing a new person meets is a
 * confusing error.
 *
 * Idempotent by design, because Compose runs it on every start. Running it again does not create a
 * second merchant, and it issues a key only when the merchant has none; a merchant who already has
 * one is told to look in their own records rather than handed another, since a key this prints is a
 * key in a scrollback buffer.
 *
 * The cursor starts at the chain tip. Starting at genesis would scan years of history looking for
 * payments that did not exist yet, and there is no earlier money owed to anyone: a payment cannot be
 * created before its network has a cursor.
 */

const MERCHANT_NAME = process.env.BOOTSTRAP_MERCHANT_NAME ?? 'Local Merchant';

async function readChainTip(rpcUrl: string): Promise<{ height: bigint; reference: string } | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // An endpoint that answers 200 with a JSON-RPC error body is a real failure mode on public
    // infrastructure, so the result is inspected rather than the status code.
    const body = (await response.json()) as {
      result?: { number?: string; hash?: string };
      error?: unknown;
    };
    const number = body.result?.number;
    const hash = body.result?.hash;
    if (number === undefined || hash === undefined) {
      return null;
    }
    return { height: BigInt(number), reference: hash.toLowerCase() };
  } catch {
    return null;
  }
}

async function ensureCursors(pool: Pool, configuration: ReturnType<typeof loadConfiguration>) {
  const networks = ['polygon-amoy', 'polygon-mainnet', 'local-anvil'].filter((candidate) =>
    isNetworkIdentifier(candidate),
  );

  for (const network of networks) {
    const [rpcUrl] = rpcUrlsFor(configuration, network);
    if (rpcUrl === undefined) {
      continue;
    }

    const existing = await pool.query('SELECT 1 FROM block_cursors WHERE network_identifier = $1', [
      network,
    ]);
    if (existing.rowCount !== 0) {
      process.stdout.write(`  ${network}: already being watched\n`);
      continue;
    }

    const tip = await readChainTip(rpcUrl);
    if (tip === null) {
      process.stdout.write(`  ${network}: no cursor, because the endpoint did not answer\n`);
      continue;
    }

    await pool.query(
      `INSERT INTO block_cursors
         (network_identifier, last_scanned_height, last_scanned_reference, current_scan_range)
       VALUES ($1, $2, $3, 20)
       ON CONFLICT (network_identifier) DO NOTHING`,
      [network, tip.height.toString(), tip.reference],
    );
    process.stdout.write(`  ${network}: watching from block ${tip.height.toString()}\n`);
  }
}

async function ensureMerchant(pool: Pool, ulidFactory: UlidFactory): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM merchants ORDER BY created_at LIMIT 1',
  );
  const found = existing.rows[0];
  if (found !== undefined) {
    process.stdout.write(`  merchant ${found.id} already exists\n`);
    return found.id;
  }

  const merchantId = `mch_${ulidFactory.create(Date.now())}`;
  await pool.query(
    `INSERT INTO merchants (id, name, underpayment_tolerance_basis_points,
       overpayment_tolerance_basis_points, default_payment_lifetime_seconds)
     VALUES ($1, $2, 50, 100, 1800)`,
    [merchantId, MERCHANT_NAME],
  );
  process.stdout.write(`  merchant ${merchantId} created\n`);
  return merchantId;
}

async function ensureApiKey(
  pool: Pool,
  merchantId: string,
  environment: Environment,
  configuration: ReturnType<typeof loadConfiguration>,
  ulidFactory: UlidFactory,
  issueAnother: boolean,
): Promise<void> {
  const existing = await pool.query<{ last_four: string }>(
    `SELECT last_four FROM api_keys
      WHERE merchant_id = $1 AND environment = $2::environment_name AND revoked_at IS NULL`,
    [merchantId, environment],
  );
  const found = existing.rows[0];
  if (found !== undefined && !issueAnother) {
    process.stdout.write(
      `  a ${environment} key ending ${found.last_four} already exists; issuing another would put a second live key in a log\n`,
    );
    process.stdout.write(
      '  if that key was lost, run this again with --issue-key. The existing one keeps working.\n',
    );
    return;
  }

  const issued = generateApiKey(environment, configuration.apiKeyPepper, ulidFactory, Date.now());
  await pool.query(
    `INSERT INTO api_keys (id, merchant_id, environment, secret_digest, last_four, label)
     VALUES ($1, $2, $3::environment_name, $4, $5, 'bootstrap')`,
    [issued.keyIdentifier, merchantId, environment, issued.secretDigest, issued.lastFour],
  );

  const rule = '-'.repeat(78);
  process.stdout.write(`\n${rule}\n`);
  process.stdout.write('  This key is shown once. Copy it now.\n\n');
  process.stdout.write(`  ${issued.presentedKey}\n`);
  process.stdout.write(`${rule}\n\n`);
}

/**
 * A signing secret, and a copy of it where the bundled receiver can read it.
 *
 * Without a secret the delivery worker cannot sign, so every callback a fresh stack produces would
 * be retried until the schedule ran out and the first thing a new person sees of webhooks is a
 * failure. The secret is generated here rather than defaulted anywhere, because a signing secret
 * with a value written in a repository is a signing secret everyone has.
 *
 * The copy is written only when BOOTSTRAP_WEBHOOK_SECRET_PATH names somewhere, which in this
 * deployment is a volume the demo receiver mounts read-only. That is a merchant reading their own
 * secret, not a secret shared between two parties who should not share one.
 */
async function ensureWebhookSecret(
  pool: Pool,
  merchantId: string,
  environment: Environment,
  ulidFactory: UlidFactory,
): Promise<void> {
  const repository = new WebhookSecretRepository(pool);
  const active = await repository.activeSecrets(merchantId, environment);

  const secrets =
    active.length > 0
      ? active.map((entry) => entry.secret)
      : [await repository.issue(`whs_${ulidFactory.create(Date.now())}`, merchantId, environment)];
  process.stdout.write(
    active.length > 0
      ? `  ${active.length.toString()} active signing secret(s)\n`
      : '  a signing secret was issued\n',
  );

  const path = process.env.BOOTSTRAP_WEBHOOK_SECRET_PATH;
  if (path === undefined || path === '') {
    return;
  }
  // Readable by the group the two images share, and by nobody else.
  await writeFile(path, secrets.join(','), { encoding: 'utf8', mode: 0o640 });
  process.stdout.write(`  the receiver copy was written to ${path}\n`);
}

async function main(): Promise<void> {
  const parameters = process.argv.slice(2);
  const requested = parameters.find((parameter) => !parameter.startsWith('--')) ?? 'test';
  if (!isEnvironment(requested)) {
    process.stderr.write('Usage: node bootstrap-cli.js <test|live> [--issue-key]\n');
    process.exit(64);
  }

  // Compose runs this on every start, so issuing a key is asked for rather than implied. It exists
  // because an operator who lost the only key otherwise has no path but hand-written SQL.
  const issueAnother = parameters.includes('--issue-key');

  const configuration = loadConfiguration(process.env);
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const ulidFactory = new UlidFactory();

  try {
    process.stdout.write('Networks:\n');
    await ensureCursors(pool, configuration);

    process.stdout.write('Merchant:\n');
    const merchantId = await ensureMerchant(pool, ulidFactory);
    await ensureApiKey(pool, merchantId, requested, configuration, ulidFactory, issueAnother);

    process.stdout.write('Webhooks:\n');
    await ensureWebhookSecret(pool, merchantId, requested, ulidFactory);
  } finally {
    await pool.end();
  }
}

await main();
