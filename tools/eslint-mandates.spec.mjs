import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The product mandates on code style are only real if they fail the build. This suite lints
 * violating snippets through the project's actual configuration and asserts each rule fires.
 *
 * Snippets are linted at paths under a `lint-fixture` segment, which `eslint.config.js` excludes
 * from type-aware linting: these files exist only in memory and belong to no tsconfig project.
 * Every mandate asserted here is syntactic, so type information is not needed to prove it.
 */

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(source, filePath) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages;
}

function ruleIdentifiers(messages) {
  return messages.map((message) => message.ruleId);
}

function messageForRule(messages, ruleIdentifier) {
  return messages.find((message) => message.ruleId === ruleIdentifier);
}

// Composed rather than written literally: this file must itself stay ASCII to pass the rule it tests.
const LATIN_SMALL_I_WITH_ACUTE = String.fromCodePoint(0x00_ed);

const DOMAIN_FIXTURE = 'apps/api/src/domain/lint-fixture/sample.ts';
const APPLICATION_FIXTURE = 'apps/api/src/application/lint-fixture/sample.ts';
const SHARED_FIXTURE = 'packages/shared/src/lint-fixture/sample.ts';

describe('code style mandates', () => {
  it('rejects else', async () => {
    const messages = await lint(
      [
        'export function classify(value: number): string {',
        '  if (value > 0) {',
        "    return 'positive';",
        '  } else {',
        "    return 'other';",
        '  }',
        '}',
      ].join('\n'),
      DOMAIN_FIXTURE,
    );
    const violation = messageForRule(messages, 'no-restricted-syntax');
    expect(violation?.message).toContain('Do not use else');
  });

  it('accepts the guard-clause form of the same function', async () => {
    const messages = await lint(
      [
        'export function classify(value: number): string {',
        '  if (value > 0) {',
        "    return 'positive';",
        '  }',
        "  return 'other';",
        '}',
      ].join('\n'),
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).not.toContain('no-restricted-syntax');
  });

  it('rejects abbreviated identifiers', async () => {
    const messages = await lint(
      'export function handle(req: unknown): unknown {\n  return req;\n}',
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).toContain('id-denylist');
    expect(messageForRule(messages, 'unicorn/name-replacements')?.message).toContain('request');
  });

  it('accepts the expanded identifier', async () => {
    const messages = await lint(
      'export function handle(request: unknown): unknown {\n  return request;\n}',
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).not.toContain('id-denylist');
    expect(ruleIdentifiers(messages)).not.toContain('unicorn/name-replacements');
  });

  it('rejects a hand-typed checksummed address literal', async () => {
    const messages = await lint(
      "export const usdc = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';",
      DOMAIN_FIXTURE,
    );
    expect(messageForRule(messages, 'no-restricted-syntax')?.message).toContain(
      'Do not hand-type a checksummed address',
    );
  });

  it('accepts the lowercase form of the same address', async () => {
    const messages = await lint(
      "export const usdc = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';",
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).not.toContain('no-restricted-syntax');
  });

  it('rejects a non-ASCII literal in backend source', async () => {
    const messages = await lint(
      `export const label = 'conclu${LATIN_SMALL_I_WITH_ACUTE}do';`,
      DOMAIN_FIXTURE,
    );
    expect(messageForRule(messages, 'no-restricted-syntax')?.message).toContain('ASCII English');
  });

  it('rejects TODO comments', async () => {
    const messages = await lint(
      '// TODO: settle this later\nexport const ready = true;',
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).toContain('no-warning-comments');
  });

  it('refuses to let a mandate be disabled inline', async () => {
    const messages = await lint(
      [
        '// eslint-disable-next-line no-restricted-syntax -- deliberate attempt',
        'export function classify(value: number): string {',
        '  if (value > 0) {',
        "    return 'positive';",
        '  } else {',
        "    return 'other';",
        '  }',
        '}',
      ].join('\n'),
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).toContain(
      '@eslint-community/eslint-comments/no-restricted-disable',
    );
  });
});

describe('architecture boundaries', () => {
  it('stops the domain layer importing viem', async () => {
    const messages = await lint(
      "import { getAddress } from 'viem';\nexport const normalize = getAddress;",
      DOMAIN_FIXTURE,
    );
    expect(messageForRule(messages, 'no-restricted-imports')?.message).toContain(
      'The domain layer must not depend on infrastructure',
    );
  });

  it('stops the domain layer importing the prisma client', async () => {
    const messages = await lint(
      "import { PrismaClient } from '@prisma/client';\nexport const client = PrismaClient;",
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).toContain('no-restricted-imports');
  });

  it('stops the application layer importing an adapter package', async () => {
    const messages = await lint(
      "import { createPublicClient } from 'viem';\nexport const create = createPublicClient;",
      APPLICATION_FIXTURE,
    );
    expect(messageForRule(messages, 'no-restricted-imports')?.message).toContain(
      'The application layer depends on ports',
    );
  });

  it('stops chain vocabulary leaking into the domain', async () => {
    const messages = await lint('export const chainId = 137;', DOMAIN_FIXTURE);
    expect(messageForRule(messages, 'no-restricted-syntax')?.message).toContain(
      'Chain-specific vocabulary belongs in infrastructure',
    );
  });

  it('allows ledger vocabulary in the domain', async () => {
    const messages = await lint(
      'export const position = { height: 1n, reference: "0xabc" };',
      DOMAIN_FIXTURE,
    );
    expect(ruleIdentifiers(messages)).not.toContain('no-restricted-syntax');
  });

  it('keeps node builtins out of the browser-safe shared surface', async () => {
    const messages = await lint(
      "import { createHmac } from 'node:crypto';\nexport const sign = createHmac;",
      SHARED_FIXTURE,
    );
    expect(messageForRule(messages, 'no-restricted-imports')?.message).toContain(
      'must not import node builtins',
    );
  });

  it('permits node builtins under the shared server entrypoint', async () => {
    const messages = await lint(
      "import { createHmac } from 'node:crypto';\nexport const sign = createHmac;",
      'packages/shared/src/server/lint-fixture/sample.ts',
    );
    expect(ruleIdentifiers(messages)).not.toContain('no-restricted-imports');
  });
});
