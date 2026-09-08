import javascript from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import vitest from '@vitest/eslint-plugin';
import prettierCompatibility from 'eslint-config-prettier';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import typescriptEslint from 'typescript-eslint';

/**
 * The product mandates on style are enforced here rather than in review. A rule that only lives in
 * a document is a rule that decays; `tools/eslint-mandates.spec.mjs` asserts that each of these
 * actually fires.
 */

const NO_ELSE = {
  selector: 'IfStatement > .alternate',
  message:
    'Do not use else. Prefer a guard clause, an early return, a lookup map, or a switch over a discriminated union.',
};

const NO_NON_ASCII_LITERAL = {
  selector: String.raw`Literal[value=/[^\u0000-\u007F]/]`,
  message:
    'Source must be ASCII English. Non-ASCII characters belong in user-facing frontend copy, not in backend literals.',
};

// A 40-digit hex address containing any uppercase hex letter is a hand-typed EIP-55 checksum.
// Addresses are stored and compared lowercase; the checksummed form is derived by getAddress().
const NO_CHECKSUMMED_ADDRESS_LITERAL = {
  selector: 'Literal[value=/^0x(?=[0-9a-fA-F]{40}$)[0-9a-fA-F]*[A-F][0-9a-fA-F]*$/]',
  message:
    'Do not hand-type a checksummed address. Store addresses lowercase and derive the checksummed form with viem getAddress() at the presentation boundary.',
};

// blockTag: 'safe' type-checks in viem and fails at runtime on Polygon.
const NO_SAFE_BLOCK_TAG = {
  selector: "Property[key.name='blockTag'][value.value='safe']",
  message:
    "blockTag 'safe' is accepted by viem's types but is not served by Polygon. Use 'finalized' or a numeric height.",
};

const BANNED_IDENTIFIERS = [
  'req',
  'res',
  'ctx',
  'cfg',
  'conf',
  'tx',
  'txn',
  'addr',
  'amt',
  'usr',
  'msg',
  'err',
  'cb',
  'fn',
  'idx',
  'num',
  'str',
  'obj',
  'arr',
  'val',
  'tmp',
  'temp',
  'db',
  'conn',
  'cur',
  'curr',
  'prev',
  'acc',
  'opts',
  'el',
  'evt',
  'btn',
  'img',
  'src',
  'dst',
  'len',
  'cnt',
  'sig',
  'hdr',
  'resp',
  'mgr',
  'repo',
  'acct',
  'bal',
  'calc',
  'impl',
  'svc',
  'ctrl',
  'dto',
  'param',
  'gen',
  'init',
  'auth',
  'sub',
  'pub',
];

const ABBREVIATION_REPLACEMENTS = {
  req: { request: true },
  res: { response: true },
  ctx: { context: true },
  cfg: { configuration: true },
  conf: { configuration: true },
  tx: { transaction: true },
  txn: { transaction: true },
  addr: { address: true },
  amt: { amount: true },
  usr: { user: true },
  msg: { message: true },
  err: { error: true },
  cb: { callback: true },
  fn: { handler: true },
  idx: { index: true },
  num: { count: true },
  str: { text: true },
  val: { value: true },
  tmp: { temporary: true },
  temp: { temporary: true },
  db: { database: true },
  conn: { connection: true },
  prev: { previous: true },
  acc: { accumulator: true },
  opts: { options: true },
  el: { element: true },
  evt: { event: true },
  btn: { button: true },
  src: { source: true },
  dst: { destination: true },
  len: { length: true },
  cnt: { count: true },
  sig: { signature: true },
  hdr: { header: true },
  resp: { response: true },
  mgr: { manager: true },
  repo: { repository: true },
  acct: { account: true },
  bal: { balance: true },
  impl: { implementation: true },
  svc: { service: true },
  ctrl: { controller: true },
  param: { parameter: true },
  params: { parameters: true },
  auth: { authentication: true },
  // unicorn's defaults propose these contractions, which invert the no-abbreviation mandate.
  repository: false,
  application: false,
  configuration: false,
  transaction: false,
  environment: false,
  // Established names that must not be rewritten.
  env: false,
  props: false,
  ref: false,
  args: false,
};

// Acronyms and ecosystem-fixed names that are clearer short than expanded.
/**
 * Property names a library defines, which this codebase does not get to choose.
 *
 * Renaming `queryFn` does not rename it in TanStack Query; it produces an object the library ignores.
 * The mandate is about identifiers someone here picked, and these are not those. Kept as an explicit
 * short list rather than a pattern, so a genuinely abbreviated name of our own still fails.
 */
const LIBRARY_PROPERTY_NAMES = ['queryFn', 'mutationFn', 'gcTime', 'refetchInterval'];

const ALLOWED_SHORT_NAMES = [
  'id',
  'url',
  'uri',
  'api',
  'http',
  'https',
  'rpc',
  'abi',
  'eip',
  'erc',
  'hmac',
  'jwt',
  'kms',
  'sql',
  'ssl',
  'tls',
  'dns',
  'uuid',
  'cli',
  'csp',
  'hd',
  'bip',
  'usd',
  'utc',
  'ui',
  'to',
  'on',
  // Option names owned by third-party APIs, which cannot be renamed here.
  'genReqId',
  'authTagLength',
  'Params',
  // JSON-RPC wire field names, fixed by the protocol.
  'params',
];

const INFRASTRUCTURE_ONLY_PACKAGES = [
  'viem',
  'viem/*',
  'wagmi',
  'wagmi/*',
  '@prisma/client',
  'prisma',
  'fastify',
  '@fastify/*',
  'undici',
  'pino',
  'pino-*',
  'prom-client',
];

// Chain-shaped vocabulary must not leak into the layers that model payments. This is what keeps a
// second blockchain an adapter instead of a rewrite.
const NO_CHAIN_VOCABULARY = {
  selector:
    'Identifier[name=/^(blockHash|logIndex|topics|topic0|abi|chainId|gasLimit|gasPrice|slot|nonce)$/]',
  message:
    'Chain-specific vocabulary belongs in infrastructure/chain. The domain and application layers speak ledger terms (position, reference, eventIndex) with opaque string identifiers.',
};

export default typescriptEslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
      'apps/api/prisma/migrations/**',
      'apps/*/src/generated/**',
    ],
  },

  javascript.configs.recommended,
  ...typescriptEslint.configs.recommended,
  unicorn.configs.recommended,
  eslintComments.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_ELSE,
        NO_NON_ASCII_LITERAL,
        NO_CHECKSUMMED_ADDRESS_LITERAL,
        NO_SAFE_BLOCK_TAG,
      ],

      'id-denylist': ['error', ...BANNED_IDENTIFIERS],
      'unicorn/name-replacements': [
        'error',
        {
          checkFilenames: true,
          checkProperties: true,
          checkShorthandProperties: true,
          extendDefaultReplacements: true,
          replacements: ABBREVIATION_REPLACEMENTS,
          allowList: Object.fromEntries(
            [...ALLOWED_SHORT_NAMES, ...LIBRARY_PROPERTY_NAMES].map((name) => [name, true]),
          ),
        },
      ],

      'no-warning-comments': [
        'error',
        {
          terms: [
            'todo',
            'fixme',
            'xxx',
            'hack',
            'placeholder',
            'tbd',
            'wip',
            'for now',
            'coming soon',
            'not implemented',
          ],
          location: 'anywhere',
        },
      ],

      // 'after-used' still forbids an unused trailing parameter, while allowing a leading one that a
      // framework supplies positionally. There is deliberately no argsIgnorePattern: an underscore
      // prefix would let anything be silenced.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', caughtErrors: 'all', ignoreRestSiblings: false },
      ],
      'no-unused-vars': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-return-await': 'error',
      'prefer-const': 'error',
      'no-param-reassign': ['error', { props: true }],

      // Silencing a mandate must itself be visible and justified.
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-restricted-disable': [
        'error',
        'no-restricted-syntax',
        'unicorn/name-replacements',
        'id-denylist',
        'no-warning-comments',
      ],

      // Opinions from unicorn that fight the naming mandate or add no value here.
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/switch-case-braces': 'off',
      // Rewrites single-line JSDoc into a block without leading asterisks, which no other tool emits.
      'unicorn/single-line-block-comment-style': 'off',
      // Cannot see through a Promise, so it misreads every async predicate as a non-boolean.
      'unicorn/consistent-boolean-name': 'off',
      // Named imports document what is used; a default namespace import hides it.
      'unicorn/import-style': 'off',
      // Prefers every private member before every public one. This codebase orders members
      // narratively instead: the public surface first, the helpers it delegates to underneath,
      // which is the order a reviewer reads them in.
      'unicorn/consistent-class-member-order': 'off',
    },
  },

  // Type-aware rules apply to real workspace source only. Configuration files, scripts and tooling
  // are linted without type information so they need not belong to a tsconfig project.
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}', 'apps/*/app/**/*.{ts,tsx}'],
    // Virtual files used by the rule-enforcement suite belong to no tsconfig project, so they are
    // linted for syntax mandates only. Nothing real is ever written to this path.
    ignores: ['**/lint-fixture/**'],
    extends: [
      ...typescriptEslint.configs.recommendedTypeChecked,
      ...typescriptEslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
    },
  },

  /**
   * The App Router derives route parameters from directory names, so `[paymentId]` is the name of an
   * API rather than a filename someone chose. Renaming it to kebab case would make every read of it
   * `params['payment-id']`, which is worse in exchange for nothing.
   */
  {
    files: ['apps/web/src/app/**/*.{ts,tsx}'],
    rules: { 'unicorn/filename-case': 'off' },
  },

  // The domain layer is pure: it may reach for node builtins and packages/shared, nothing else.
  {
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: INFRASTRUCTURE_ONLY_PACKAGES,
              message:
                'The domain layer must not depend on infrastructure. Move this behind a port in application/ports.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        NO_ELSE,
        NO_NON_ASCII_LITERAL,
        NO_CHECKSUMMED_ADDRESS_LITERAL,
        NO_SAFE_BLOCK_TAG,
        NO_CHAIN_VOCABULARY,
      ],
    },
  },

  // The application layer owns the ports; it must not know which adapter implements them.
  {
    files: ['apps/api/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: INFRASTRUCTURE_ONLY_PACKAGES,
              message:
                'The application layer depends on ports, not adapters. Import from application/ports instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        NO_ELSE,
        NO_NON_ASCII_LITERAL,
        NO_CHECKSUMMED_ADDRESS_LITERAL,
        NO_SAFE_BLOCK_TAG,
        NO_CHAIN_VOCABULARY,
      ],
    },
  },

  // The shared package is imported by the browser bundle, so its public surface stays node-free.
  {
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['packages/shared/src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'The browser-safe surface of packages/shared must not import node builtins. Put node-only code under packages/shared/src/server.',
            },
          ],
        },
      ],
    },
  },

  // Frontend code renders for people: non-ASCII glyphs are legitimate design elements there.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-syntax': ['error', NO_ELSE, NO_CHECKSUMMED_ADDRESS_LITERAL, NO_SAFE_BLOCK_TAG],
    },
  },

  {
    files: ['**/*.{spec,test}.{ts,tsx,mjs,js}', '**/test/**/*.{ts,mjs}', '**/e2e/**/*.ts'],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'error',
      // Assertions are frequently wrapped in a named helper so the intent reads in the test name.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', 'assert*'] }],
      'vitest/no-disabled-tests': 'warn',
      'no-console': 'off',
      'unicorn/name-replacements': 'off',
      // The import restrictions protect what ships. A spec ships nowhere.
      'no-restricted-imports': 'off',
      // Assigning a module-level binding from beforeAll is how every framework-managed fixture is
      // wired; the rule would forbid the standard lifecycle.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // This rule autofixes http:// to https://. In a spec that asserts a plain-HTTP URL is
      // rejected, that silently inverts the test into one that proves nothing.
      'unicorn/prefer-https': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs', '*.config.{js,mjs,ts}', 'eslint.config.js'],
    rules: {
      'no-console': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/no-anonymous-default-export': 'off',
      // This file names the banned identifiers in order to ban them.
      'id-denylist': 'off',
    },
  },

  prettierCompatibility,
);
