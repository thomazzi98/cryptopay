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
