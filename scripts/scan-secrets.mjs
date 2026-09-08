#!/usr/bin/env node

/**
 * Refuses to let a credential reach the repository.
 *
 * Runs as a pre-commit hook and again in CI, over the files git actually tracks. Scanning tracked
 * files rather than the working tree is deliberate: an ignored `.env` is exactly what should exist
 * locally, and the failure worth preventing is one becoming committed.
 *
 * The patterns live in tools/secret-patterns.mjs and are covered by their own spec. A broader
 * third-party scanner also runs in CI over the full history, which is defence in depth rather than
 * duplication: this one knows what a CryptoPay API key looks like, and that one knows what
 * everyone else's credentials look like.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';

import { buildFindings, findTrackedEnvironmentFiles } from '../tools/secret-patterns.mjs';

const executeFile = promisify(execFile);

const SKIPPED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.pdf',
  '.lock',
]);

/**
 * The scanner's own definition and its spec necessarily contain example credentials: the patterns
 * that recognise a key, and the fixtures that prove they still do. Excluding exactly these two
 * files, by name, is narrower than allowlisting each example value, and it keeps the fixtures free
 * to change without anyone editing an allowlist.
 */
const SELF_REFERENTIAL_PATHS = new Set([
  'tools/secret-patterns.mjs',
  'tools/secret-scanner.spec.mjs',
]);

/**
 * Values that genuinely have the shape of a credential and genuinely are not one.
 *
 * TRON names a transaction with sixty-four lowercase hex characters and no prefix, which is
 * byte-for-byte the shape this scanner uses to recognise a private key. The shapes cannot be told
 * apart, so real TRON transaction ids are listed here one at a time, by value.
 *
 * By value rather than by path, and one at a time rather than by pattern, for the same reason the
 * gitleaks configuration works that way: excluding a file retires the scanner for everything that
 * file will ever contain, and a spec is exactly where somebody eventually pastes a real key.
 */
const ALLOWED_VALUES = new Set([
  // A real transfer on TRON Nile, read from TronGrid and used to prove reference canonicalisation.
  'f0718be7e2f71a893c06d634382554a24c862bc54ab26cdb8224deff5f629802',
]);

const SKIPPED_PATHS = new Set(['package-lock.json']);
const MAXIMUM_LISTING_BYTES = 16 * 1024 * 1024;

async function listTrackedFiles() {
  const { stdout } = await executeFile('git', ['ls-files'], { maxBuffer: MAXIMUM_LISTING_BYTES });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !SKIPPED_EXTENSIONS.has(extname(line)))
    .filter((line) => !SKIPPED_PATHS.has(line))
    .filter((line) => !SELF_REFERENTIAL_PATHS.has(line));
}

async function readIfText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A finding is dismissed only when the line it sits on carries one of the listed values. Matching
 * the line rather than the file keeps the exemption to the value that earned it.
 */
function isAllowedValue(contents, finding) {
  const line = contents.split('\n')[finding.lineNumber - 1] ?? '';
  return [...ALLOWED_VALUES].some((value) => line.includes(value));
}

async function main() {
  const files = await listTrackedFiles();
  const findings = Array.from(findTrackedEnvironmentFiles(files), (path) => ({
    path,
    lineNumber: 0,
    reason: 'an environment file is tracked by git',
  }));

  for (const path of files) {
    const contents = await readIfText(path);
    if (contents === null) {
      continue;
    }
    findings.push(
      ...buildFindings(path, contents).filter((finding) => !isAllowedValue(contents, finding)),
    );
  }

  if (findings.length === 0) {
    process.stdout.write(`Scanned ${files.length} tracked files. No credentials found.\n`);
    return;
  }

  process.stderr.write('\nRefusing to proceed: possible credentials in tracked files.\n\n');
  for (const finding of findings) {
    process.stderr.write(`  ${finding.path}:${finding.lineNumber}  ${finding.reason}\n`);
  }
  process.stderr.write(
    '\nMove the value into .env, which is gitignored. If it was ever committed, rotate it: the\n' +
      'history keeps it even after the file is deleted.\n',
  );
  process.exitCode = 1;
}

await main();
