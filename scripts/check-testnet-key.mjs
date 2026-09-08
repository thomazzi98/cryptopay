#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createPublicClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Refuses to let a key with mainnet history be used as a testnet key.
 *
 * This exists because the assumption it checks is wrong and feels right. A variable named
 * AMOY_TESTNET_PRIVATE_KEY reads as though the key is confined to Amoy; it is not. One secp256k1
 * key controls the same address on every EVM chain at once, so a key that also holds mainnet funds
 * is a mainnet key that happens to be written down in a development file.
 *
 * That is not hypothetical here: the key first configured for this repository turned out to hold
 * real POL on Polygon mainnet and to have already signed six transactions there. Nothing caught it,
 * because a secret scanner looks for keys in the wrong place — a key in a gitignored .env is exactly
 * where a key belongs, and no pattern can tell a funded one from a throwaway. Only the chain can.
 *
 * The key is never printed, never logged and never sent anywhere. It is used locally to derive an
 * address, and only that address goes over the wire.
 */

const MAINNET_ENDPOINTS = Object.freeze([
  { name: 'Polygon', url: 'https://polygon-bor-rpc.publicnode.com', chainIdentifier: 137 },
  { name: 'Ethereum', url: 'https://ethereum-rpc.publicnode.com', chainIdentifier: 1 },
  { name: 'Base', url: 'https://base-rpc.publicnode.com', chainIdentifier: 8453 },
  { name: 'Arbitrum One', url: 'https://arbitrum-one-rpc.publicnode.com', chainIdentifier: 42_161 },
]);

const ENVIRONMENT_FILE = '.env';
const KEY_VARIABLE = 'AMOY_TESTNET_PRIVATE_KEY';

/** Below this the answer is "unknown", and unknown must never be reported as "clean". */
const MINIMUM_REACHABLE_ENDPOINTS = 3;

function normalise(raw) {
  const trimmed = raw.trim().replaceAll(/^["']|["']$/g, '');
  if (trimmed === '') {
    return null;
  }
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/**
 * The environment first, then the file.
 *
 * CI has no `.env`. It hands the key to this process as an environment variable, which is precisely
 * the case this check exists for, and reading only the file meant the workflow step that refuses a
 * mainnet-funded key printed "nothing to check" and exited zero on every run. The gate had never
 * once been applied to the key it was guarding.
 */
function readConfiguredKey() {
  const fromEnvironment = process.env[KEY_VARIABLE];
  if (fromEnvironment !== undefined) {
    return normalise(fromEnvironment);
  }

  let contents;
  try {
    contents = readFileSync(ENVIRONMENT_FILE, 'utf8');
  } catch {
    return null;
  }

  const line = contents.split('\n').find((entry) => entry.startsWith(`${KEY_VARIABLE}=`));
  if (line === undefined) {
    return null;
  }
  return normalise(line.slice(KEY_VARIABLE.length + 1));
}

async function inspect(endpoint, address) {
  const client = createPublicClient({ transport: http(endpoint.url, { timeout: 12_000 }) });
  try {
    const chainIdentifier = await client.getChainId();
    // An endpoint quietly serving a different chain would report a balance from somewhere else, and
    // the whole answer would be about the wrong network.
    if (chainIdentifier !== endpoint.chainIdentifier) {
      return { name: endpoint.name, reachable: false, detail: 'the endpoint served another chain' };
    }
    const [balance, transactionCount] = await Promise.all([
      client.getBalance({ address }),
      client.getTransactionCount({ address }),
    ]);
    return { name: endpoint.name, reachable: true, balance, transactionCount };
  } catch (error) {
    return {
      name: endpoint.name,
      reachable: false,
      detail: error instanceof Error ? error.message.slice(0, 80) : 'unreachable',
    };
  }
}

async function main() {
  // A caller that depends on this check having run passes --required, so a missing key fails rather
  // than passing quietly. That is the difference between a gate and a decoration.
  const required = process.argv.includes('--required');
  const key = readConfiguredKey();
  if (key === null) {
    const where = `${KEY_VARIABLE} (environment, or ${ENVIRONMENT_FILE})`;
    if (required) {
      console.error(`No ${where} is set, and --required was given. Refusing to continue.`);
      process.exitCode = 1;
      return;
    }
    console.log(`No ${where} is configured. Nothing to check.`);
    return;
  }

  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    console.error(`${KEY_VARIABLE} is not a valid secp256k1 private key.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Checking ${account.address} against mainnet chains.`);
  console.log('The key itself is never sent anywhere; only the address it derives to.\n');

  const reports = await Promise.all(
    MAINNET_ENDPOINTS.map((endpoint) => inspect(endpoint, account.address)),
  );

  const used = [];
  for (const report of reports) {
    if (!report.reachable) {
      console.log(`  ${report.name.padEnd(14)} could not be checked (${report.detail})`);
      continue;
    }
    const active = report.balance > 0n || report.transactionCount > 0;
    const marker = active ? 'USED' : 'clean';
    console.log(
      `  ${report.name.padEnd(14)} ${marker.padEnd(6)} ${formatEther(report.balance)} native, ${report.transactionCount.toString()} transactions sent`,
    );
    if (active) {
      used.push(report);
    }
  }

  // Failing closed. An endpoint that did not answer is not evidence of a clean key, and a check
  // that announces safety after asking nobody is worse than no check at all, because it is believed.
  const reachable = reports.filter((report) => report.reachable);
  if (reachable.length < MINIMUM_REACHABLE_ENDPOINTS) {
    console.error(
      `\nOnly ${reachable.length.toString()} of ${reports.length.toString()} chains answered, and ${MINIMUM_REACHABLE_ENDPOINTS.toString()} are required.`,
    );
    console.error(
      'This key has not been cleared. Run this again when the endpoints are reachable.',
    );
    process.exitCode = 1;
    return;
  }

  if (used.length === 0) {
    console.log(
      `\nChecked ${reachable.length.toString()} chains. This key has no mainnet balance and no mainnet history.`,
    );
    return;
  }

  console.error(
    `\nRefusing to treat this as a testnet key: it is active on ${used.map((report) => report.name).join(', ')}.`,
  );
  console.error(
    'A private key is not confined to one chain. Move the funds off this address, retire it, and',
  );
  console.error('generate a key that has never been funded anywhere before using it here.');
  process.exitCode = 1;
}

await main();
