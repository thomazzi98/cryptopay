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

  // The chain codes and private keys of both ed25519 test vectors published in SLIP-0010. They are
  // private keys in every sense the scanner can see, and that is the point: the specification
  // publishes them so an implementation can prove it derives the same values. Listing all
  // twenty-four by value keeps the exemption on the vectors themselves, so a real key pasted into
  // the same file is still caught.
  '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
  '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
  '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
  '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
  'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
  'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
  '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
  '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
  '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
  '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
  '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
  '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
  'ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b',
  '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012',
  '0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d',
  '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635',
  '138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f',
  'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4',
  '73bd9fff1cfbde33a1b846c27085f711c0fe2d66fd32e139d3ebc28e5a4a6b90',
  '3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c',
  '0902fe8a29f9140480a00ef244bd183e8a13288e4412d8389d140aac1794825a',
  '5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72',
  '5d70af781f3a37b829f0d060924d5e960bdc02e85423494afc0b1a41bbe196d4',
  '551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d',
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
