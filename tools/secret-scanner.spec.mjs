import { describe, expect, it } from 'vitest';

import {
  buildFindings,
  findTrackedEnvironmentFiles,
  looksLikeRealSecret,
} from './secret-patterns.mjs';

/**
 * The secret scanner protects the one mistake that cannot be undone by a revert: a credential
 * reaching a public repository. A scanner that silently stops matching is worse than none, so its
 * detections and its non-detections are both asserted.
 */

const REAL_LOOKING_KEY = '4c0883a69102937d6231471b5dbb6204fe512961708279e6a3f2c1b8d9e4a7f3';

/**
 * Credential fixtures are assembled here rather than written out.
 *
 * A literal that matches a credential pattern is a leak to every scanner that reads the file,
 * including GitHub's, whatever the value actually is. Building the fixture from parts means this
 * file can assert that the shape is caught without containing the shape.
 */
const VARIED_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomLookingTail(length) {
  return Array.from(
    { length },
    (unused, index) => VARIED_ALPHABET[(index * 7 + 3) % VARIED_ALPHABET.length],
  ).join('');
}

function credentialShaped(head, tail, tailLength) {
  return `${head}${tail}${randomLookingTail(tailLength)}`;
}

describe('detecting a leaked secret', () => {
  it.each([
    {
      description: 'an environment assignment',
      line: `AMOY_TESTNET_PRIVATE_KEY=${REAL_LOOKING_KEY}`,
    },
    {
      description: 'an object property',
      line: `const config = { AMOY_TESTNET_PRIVATE_KEY: '${REAL_LOOKING_KEY}' };`,
    },
    { description: 'a bare private key', line: `const key = "${REAL_LOOKING_KEY}";` },
    { description: 'a pepper', line: 'API_KEY_PEPPER=k7Qm2xR9vT4wY8nL3pJ6bC5hF1sD0gZa' },
    { description: 'a PEM block', line: '-----BEGIN EC PRIVATE KEY-----' },
    {
      description: 'a complete API key',
      line: 'const key = "cp_test_01K4QW6ZR2M8X4T7YQ0C3D5B9N_x7Kq2mR9vT4wY8nL3pJ6bC5hF1sD0gZaQwErTyUiOpA";',
    },
  ])('flags $description', ({ line }) => {
    expect(buildFindings('sample.ts', line)).not.toHaveLength(0);
  });
});

/**
 * The class the name-based rules cannot see. A signing secret assigned to a name no list contains
 * reached GitHub, which raised two alerts against it; these assertions are what stop that recurring.
 */
describe('detecting a credential by its prefix alone', () => {
  it.each([
    ['a webhook signing secret', 'wh', 'sec_', 32],
    ['a Stripe secret key', 'sk_', 'live_', 24],
    ['a GitHub personal access token', 'gh', 'p_', 36],
    ['an AWS access key identifier', 'AK', 'IA', 16],
    ['a Slack bot token', 'xo', 'xb-', 24],
    ['a Google API key', 'AI', 'za', 35],
    ['an npm token', 'np', 'm_', 36],
    ['a BIP-32 extended private key', 'xp', 'rv', 104],
  ])('refuses %s however it is named', (unusedName, head, tail, tailLength) => {
    const line = `const anythingAtAll = '${credentialShaped(head, tail, tailLength)}';`;
    expect(buildFindings('src/whatever.ts', line)).not.toHaveLength(0);
  });

  it('catches it in an object property, a call argument and an environment line alike', () => {
    const value = credentialShaped('wh', 'sec_', 32);
    const shapes = [
      `  signingSecret: '${value}',`,
      `  verify(request, '${value}');`,
      `WEBHOOK_SECRET=${value}`,
    ];
    for (const shape of shapes) {
      expect(buildFindings('src/whatever.ts', shape)).not.toHaveLength(0);
    }
  });

  /**
   * The prefix on its own carries no key material. Refusing it would fire on the constant in the
   * signing module and on the CHECK constraint in the migration, and a scanner that cries wolf is a
   * scanner nobody keeps.
   */
  it('leaves a bare prefix constant alone', () => {
    expect(buildFindings('src/webhook-signature.ts', `const SECRET_PREFIX = 'whsec_';`)).toEqual(
      [],
    );
  });

  it('leaves a SQL constraint on the prefix alone', () => {
    const line = `  secret TEXT NOT NULL CHECK (secret LIKE 'whsec_%'),`;
    expect(buildFindings('migrations/0002_callbacks.sql', line)).toEqual([]);
  });

  it('leaves a repeated-character fixture alone, because it carries no entropy', () => {
    const line = `const fixture = 'whsec_${'k'.repeat(40)}';`;
    expect(buildFindings('src/whatever.spec.ts', line)).toEqual([]);
  });
});

describe('leaving legitimate code alone', () => {
  it.each([
    { description: 'a constructed test fixture', line: "const PEPPER = 'p'.repeat(48);" },
    {
      description: 'a buffer fixture',
      line: "WALLET_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),",
    },
    { description: 'a variable reference', line: 'API_KEY_PEPPER: PEPPER,' },
    { description: 'an empty placeholder', line: 'WALLET_KEY_ENCRYPTION_KEY=' },
    {
      description: 'prose naming the variable',
      line: ' * Back up WALLET_KEY_ENCRYPTION_KEY: without it the seed cannot be opened.',
    },
    { description: 'a prefixed transaction hash', line: `const hash = "0x${'a'.repeat(64)}";` },
    { description: 'a repeated-character fixture', line: `const filler = "${'b'.repeat(64)}";` },
    {
      description: 'the published development mnemonic',
      line: "const MNEMONIC = 'test test test test test test test test test test test junk';",
    },
  ])('ignores $description', ({ line }) => {
    expect(buildFindings('sample.ts', line)).toHaveLength(0);
  });
});

describe('classifying an assigned value', () => {
  it('treats a high-entropy literal as a secret', () => {
    expect(looksLikeRealSecret(`'${REAL_LOOKING_KEY}'`)).toBe(true);
  });

  it.each([
    { description: 'an expression', value: "'a'.repeat(32)" },
    { description: 'a constant reference', value: 'PEPPER' },
    { description: 'a short value', value: "'abc'" },
    { description: 'an explicit placeholder', value: 'replace-me-with-something-long-enough' },
    { description: 'a template literal', value: '`${prefix}-value-that-is-long-enough`' },
  ])('does not treat $description as a secret', ({ value }) => {
    expect(looksLikeRealSecret(value)).toBe(false);
  });
});

describe('tracked environment files', () => {
  it('reports a tracked .env whatever it contains', () => {
    expect(findTrackedEnvironmentFiles(['.env', 'src/index.ts'])).toStrictEqual(['.env']);
  });

  it('reports a nested environment file', () => {
    expect(findTrackedEnvironmentFiles(['apps/api/.env.production'])).toStrictEqual([
      'apps/api/.env.production',
    ]);
  });

  it('permits the committed templates', () => {
    expect(findTrackedEnvironmentFiles(['.env.example', '.env.testnet.example'])).toHaveLength(0);
  });
});
