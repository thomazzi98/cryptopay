/**
 * The patterns that decide whether a tracked file contains a credential.
 *
 * Kept apart from the command that runs them so they can be exercised directly by a spec. A scanner
 * whose detections are never asserted quietly stops matching, and nobody notices until the day it
 * mattered.
 */

/**
 * Values that are published, fabricated or structural, and are therefore safe. Every entry has to
 * earn its place: an over-broad allowlist is how a scanner stops being trusted.
 */
const ALLOWED_SUBSTRINGS = [
  // The mnemonic every Ethereum development tool ships with. Its addresses are public and it holds
  // nothing; the wallet suite uses it as a known-answer vector.
  'test test test test test test test test test test test junk',
  // The deliberately unusable filler shown in .env.example.
  'replace-me-with-at-least-thirty-two-characters',
];

const SECRET_VARIABLE_NAMES = [
  'AMOY_TESTNET_PRIVATE_KEY',
  'API_KEY_PEPPER',
  'WALLET_KEY_ENCRYPTION_KEY',
  'WEBHOOK_KEY_ENCRYPTION_KEY',
  'PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
];

const MINIMUM_SECRET_LENGTH = 16;
const MINIMUM_DISTINCT_CHARACTERS = 8;
const MINIMUM_DISTINCT_HEX_DIGITS = 5;

const FILLER_PREFIX = /^(replace|change|your|example|sample|todo|xxx|<)/i;
const COMPUTED_VALUE = /[(){}$]/;
const CONSTANT_REFERENCE = /^[A-Z][\dA-Z_]*$/;
const BARE_HEX_RUN = /(^|[^\dA-Za-z_x])([\da-fA-F]{64})(?![\dA-Za-z])/g;
const COMPLETE_API_KEY = /cp_(test|live)_[\dA-HJKMNP-TV-Z]{26}_[\w-]{43}/;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Decides whether an assigned value is a credential rather than filler or a constructed fixture.
 *
 * A value built by an expression is never a credential: `'a'.repeat(32)` and `Buffer.alloc(32, 3)`
 * produce key-shaped bytes for a test and carry no entropy anyone could use. Only a literal with
 * real variety is worth refusing.
 */
export function looksLikeRealSecret(rawValue) {
  const value = rawValue.trim().replace(/[,;)]+$/, '');
  if (COMPUTED_VALUE.test(value) || CONSTANT_REFERENCE.test(value)) {
    return false;
  }

  const literal = value.replaceAll(/^["'`]|["'`]$/g, '');
  if (literal.length < MINIMUM_SECRET_LENGTH || FILLER_PREFIX.test(literal)) {
    return false;
  }

  // Real key material has variety. A repeated character is a fixture whatever its length.
  return new Set(literal).size >= MINIMUM_DISTINCT_CHARACTERS;
}

function findAssignedSecret(line, name) {
  // Two shapes count as an assignment: an environment line, and an object property whose value is a
  // quoted literal. A bare colon is not enough, or prose naming the variable would read as a leak
  // and the scanner would be ignored within a week.
  return (
    new RegExp(String.raw`${name}\s*=\s*(.+)$`).exec(line) ??
    new RegExp(String.raw`${name}\s*:\s*(["'\`].+)$`).exec(line)
  );
}

function findingsInLine(path, line, lineNumber) {
  const findings = [];

  for (const name of SECRET_VARIABLE_NAMES) {
    const assigned = findAssignedSecret(line, name);
    if (assigned !== null && looksLikeRealSecret(assigned[1] ?? '')) {
      findings.push({ path, lineNumber, reason: `${name} is assigned a real-looking secret` });
    }
  }

  // A bare 64-character hex run is the shape of an EVM private key. Hashes in this codebase are
  // always written with the 0x prefix, so requiring its absence keeps transaction fixtures out.
  for (const match of line.matchAll(BARE_HEX_RUN)) {
    const candidate = (match[2] ?? '').toLowerCase();
    if (new Set(candidate).size >= MINIMUM_DISTINCT_HEX_DIGITS) {
      findings.push({
        path,
        lineNumber,
        reason: 'bare 64-character hex value, the shape of a private key',
      });
    }
  }

  if (COMPLETE_API_KEY.test(line)) {
    findings.push({ path, lineNumber, reason: 'a complete CryptoPay API key' });
  }
  if (PEM_PRIVATE_KEY.test(line)) {
    findings.push({ path, lineNumber, reason: 'a PEM private key block' });
  }

  return findings;
}

export function buildFindings(path, contents) {
  const findings = [];
  const lines = contents.split('\n');

  for (const [index, line] of lines.entries()) {
    if (ALLOWED_SUBSTRINGS.some((allowed) => line.includes(allowed))) {
      continue;
    }
    findings.push(...findingsInLine(path, line, index + 1));
  }

  return findings;
}

/**
 * A tracked environment file is the failure the scanner exists to prevent, so it is reported even
 * when its contents happen to look harmless today.
 */
export function findTrackedEnvironmentFiles(files) {
  return files.filter((path) => {
    const name = path.split('/').at(-1) ?? '';
    return name.startsWith('.env') && !name.endsWith('.example');
  });
}
