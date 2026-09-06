#!/usr/bin/env node

/**
 * Verifies that this machine can actually build and run CryptoPay before anything is installed.
 * Every failure prints the exact command that fixes it, because a preflight that only reports
 * "something is wrong" costs more time than it saves.
 */

import { exec } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, parse as parsePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeCommand = promisify(exec);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PASSED = 'passed';
const WARNED = 'warned';
const FAILED = 'failed';

const MINIMUM_FREE_GIGABYTES_FOR_CACHE = 8;
const MINIMUM_FREE_GIGABYTES_FOR_REPOSITORY = 10;
const BYTES_PER_GIGABYTE = 1024 ** 3;
const REQUIRED_PORTS = [3000, 3001, 4001, 5432, 8545];
const DOCKER_INFO_TIMEOUT_MILLISECONDS = 20_000;

function passed(name, detail) {
  return { name, status: PASSED, detail, remediation: null };
}

function warned(name, detail, remediation) {
  return { name, status: WARNED, detail, remediation };
}

function failed(name, detail, remediation) {
  return { name, status: FAILED, detail, remediation };
}

async function readPackageManifest() {
  const contents = await readFile(resolve(repositoryRoot, 'package.json'), 'utf8');
  return JSON.parse(contents);
}

function parseSemanticVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemanticVersions(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

async function checkNodeVersion(manifest) {
  const running = parseSemanticVersion(process.versions.node);
  const required = parseSemanticVersion(manifest.engines.node);
  if (running === null || required === null) {
    return failed(
      'Node.js version',
      `could not parse "${process.version}"`,
      'Install the Node.js version named in .nvmrc from https://nodejs.org',
    );
  }
  if (running.major !== required.major) {
    return failed(
      'Node.js version',
      `running ${process.versions.node}, this project requires major ${required.major}`,
      'Install the Node.js version named in .nvmrc',
    );
  }
  if (compareSemanticVersions(running, required) < 0) {
    return failed(
      'Node.js version',
      `running ${process.versions.node}, minimum is ${required.major}.${required.minor}.${required.patch}`,
      'Upgrade Node.js to the version named in .nvmrc',
    );
  }
  return passed('Node.js version', process.versions.node);
}

// Every command below is a fixed literal defined in this file. Nothing reaches the shell
// from configuration or user input, so shell interpolation carries no injection surface.
async function readCommandOutput(command, timeoutMilliseconds) {
  const { stdout } = await executeCommand(command, { timeout: timeoutMilliseconds });
  return stdout.trim();
}

async function checkNpmVersion() {
  const version = await readCommandOutput('npm --version');
  const running = parseSemanticVersion(version);
  if (running === null || running.major < 11) {
    return failed(
      'npm version',
      `running ${version}, minimum is 11.6.0`,
      'Run: npm install --global npm@latest',
    );
  }
  return passed('npm version', version);
}

async function readFreeGigabytes(targetPath) {
  const statistics = await statfs(targetPath);
  return (statistics.bsize * statistics.bavail) / BYTES_PER_GIGABYTE;
}

function describeVolume(targetPath) {
  return parsePath(resolve(targetPath)).root;
}

async function checkCacheDiskSpace() {
  const cacheDirectory = await readCommandOutput('npm config get cache');
  const volume = describeVolume(cacheDirectory);
  const freeGigabytes = await readFreeGigabytes(volume);
  const detail = `${freeGigabytes.toFixed(1)} GB free on ${volume} (npm cache: ${cacheDirectory})`;
  if (freeGigabytes < MINIMUM_FREE_GIGABYTES_FOR_CACHE) {
    return failed(
      'npm cache disk space',
      detail,
      `Point the npm cache at a volume with at least ${MINIMUM_FREE_GIGABYTES_FOR_CACHE} GB free by adding a "cache=<path>" line to a local .npmrc (it is gitignored), then remove node_modules and reinstall.`,
    );
  }
  return passed('npm cache disk space', detail);
}

async function checkRepositoryDiskSpace() {
  const volume = describeVolume(repositoryRoot);
  const freeGigabytes = await readFreeGigabytes(volume);
  const detail = `${freeGigabytes.toFixed(1)} GB free on ${volume}`;
  if (freeGigabytes < MINIMUM_FREE_GIGABYTES_FOR_REPOSITORY) {
    return failed(
      'repository disk space',
      detail,
      `Free at least ${MINIMUM_FREE_GIGABYTES_FOR_REPOSITORY} GB on ${volume}; dependencies and build output need the room.`,
    );
  }
  return passed('repository disk space', detail);
}

async function readGitSetting(key) {
  try {
    return await readCommandOutput(`git config ${key}`);
  } catch {
    return '';
  }
}

async function checkGitIdentity() {
  const username = await readGitSetting('user.name');
  const userEmail = await readGitSetting('user.email');
  if (username === '' || userEmail === '') {
    return failed(
      'git identity',
      'user.name or user.email is unset',
      'Run: git config user.name "Your Name" then git config user.email "you@example.com"',
    );
  }
  return passed('git identity', `${username} <${userEmail}>`);
}

async function checkDockerDaemon() {
  try {
    const serverVersion = await readCommandOutput(
      'docker info --format "{{.ServerVersion}}"',
      DOCKER_INFO_TIMEOUT_MILLISECONDS,
    );
    if (serverVersion === '') {
      throw new Error('empty server version');
    }
    return passed('docker daemon', `engine ${serverVersion}`);
  } catch {
    return warned(
      'docker daemon',
      'not reachable',
      'Start Docker Desktop. It is required for "docker compose up" and for the Postgres used by integration tests; unit tests and the local Anvil chain do not need it.',
    );
  }
}

function isPortFree(port) {
  return new Promise((resolveResult) => {
    const server = createServer();
    server.once('error', () => resolveResult(false));
    server.once('listening', () => {
      server.close(() => resolveResult(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function checkRequiredPorts() {
  const occupied = [];
  for (const port of REQUIRED_PORTS) {
    const free = await isPortFree(port);
    if (free === false) {
      occupied.push(port);
    }
  }
  if (occupied.length > 0) {
    return warned(
      'required ports',
      `in use: ${occupied.join(', ')}`,
      'Stop whatever is listening, or override the port through the matching environment variable.',
    );
  }
  return passed('required ports', `${REQUIRED_PORTS.join(', ')} free`);
}

async function runCheck(runner) {
  try {
    return await runner();
  } catch (error) {
    return failed(
      'preflight check',
      `unexpected error: ${error.message}`,
      'Re-run to see the full context: node scripts/preflight.mjs',
    );
  }
}

const STATUS_LABELS = {
  [PASSED]: 'PASS',
  [WARNED]: 'WARN',
  [FAILED]: 'FAIL',
};

function report(results) {
  const longestName = Math.max(...results.map((result) => result.name.length));
  process.stdout.write('\nCryptoPay preflight\n\n');
  for (const result of results) {
    const label = STATUS_LABELS[result.status];
    process.stdout.write(`  ${label}  ${result.name.padEnd(longestName)}  ${result.detail}\n`);
  }

  const actionable = results.filter((result) => result.remediation !== null);
  if (actionable.length === 0) {
    return;
  }
  process.stdout.write('\nAction required:\n\n');
  for (const result of actionable) {
    process.stdout.write(`  ${result.name}\n    ${result.remediation}\n\n`);
  }
}

async function main() {
  const manifest = await readPackageManifest();
  const results = await Promise.all([
    runCheck(() => checkNodeVersion(manifest)),
    runCheck(() => checkNpmVersion()),
    runCheck(() => checkCacheDiskSpace()),
    runCheck(() => checkRepositoryDiskSpace()),
    runCheck(() => checkGitIdentity()),
    runCheck(() => checkDockerDaemon()),
    runCheck(() => checkRequiredPorts()),
  ]);

  report(results);

  const failures = results.filter((result) => result.status === FAILED);
  if (failures.length > 0) {
    process.stdout.write(`Preflight failed: ${failures.length} blocking issue(s).\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Preflight passed.\n\n');
}

await main();
