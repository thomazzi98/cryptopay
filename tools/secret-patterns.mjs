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
 * Credentials recognisable by their prefix alone, whatever they are assigned to.
 *
 * This is the class the name-based rules above cannot see. A webhook signing secret assigned to a
 * plain `SECRET` constant matches no name on any list, and two of them reached GitHub, which raised
 * alerts against them. Nothing reading a credential-shaped literal can tell a fabricated value from
 * a real one, so the shape itself is refused and test values are generated instead.
 *
 * The prefixes are stored split so that this file, which describes credentials, does not itself
 * contain a string that matches one. `minimumTail` is the length of the random part alone.
 */
const CREDENTIAL_PREFIXES = [
  { name: 'a webhook signing secret', head: 'wh', tail: 'sec_', minimumTail: 20 },
  { name: 'a Stripe secret key', head: 'sk_', tail: 'live_', minimumTail: 20 },
  { name: 'a Stripe test key', head: 'sk_', tail: 'test_', minimumTail: 20 },
  { name: 'a Stripe restricted key', head: 'rk_', tail: 'live_', minimumTail: 20 },
  { name: 'a GitHub personal access token', head: 'gh', tail: 'p_', minimumTail: 30 },
  { name: 'a GitHub OAuth token', head: 'gh', tail: 'o_', minimumTail: 30 },
  { name: 'a GitHub server token', head: 'gh', tail: 's_', minimumTail: 30 },
  { name: 'a fine-grained GitHub token', head: 'github', tail: '_pat_', minimumTail: 30 },
  { name: 'an AWS access key identifier', head: 'AK', tail: 'IA', minimumTail: 16 },
  { name: 'a Slack bot token', head: 'xo', tail: 'xb-', minimumTail: 20 },
  { name: 'a Slack user token', head: 'xo', tail: 'xp-', minimumTail: 20 },
  { name: 'a Google API key', head: 'AI', tail: 'za', minimumTail: 33 },
  { name: 'a SendGrid key', head: 'SG', tail: '.', minimumTail: 40 },
  { name: 'an npm token', head: 'np', tail: 'm_', minimumTail: 34 },
  { name: 'a GitLab token', head: 'gl', tail: 'pat-', minimumTail: 20 },
  { name: 'a DigitalOcean token', head: 'do', tail: 'p_v1_', minimumTail: 60 },
  // The one that would cost the most here: an extended private key derives every address below it.
  { name: 'a BIP-32 extended private key', head: 'xp', tail: 'rv', minimumTail: 100 },
];

const MINIMUM_DISTINCT_TAIL_CHARACTERS = 8;

/**
 * Requires the prefix and a random-looking tail. Without the tail requirement the rule would fire on
 * the prefix constant in the signing module and on the CHECK constraint in the migration, both of
 * which carry no key material, and a scanner that cries wolf is a scanner nobody keeps.
 */
function findPrefixedCredentials(path, line, lineNumber) {
  const findings = [];
  for (const { name, head, tail, minimumTail } of CREDENTIAL_PREFIXES) {
    const pattern = new RegExp(
      String.raw`${head}${tail}([\w+/=-]{${minimumTail.toString()},})`,
      'g',
    );
    for (const match of line.matchAll(pattern)) {
      const random = match[1] ?? '';
      if (new Set(random).size >= MINIMUM_DISTINCT_TAIL_CHARACTERS) {
        findings.push({ path, lineNumber, reason: `${name}, recognised by its prefix` });
      }
    }
  }
  return findings;
}

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

  findings.push(...findPrefixedCredentials(path, line, lineNumber));

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
