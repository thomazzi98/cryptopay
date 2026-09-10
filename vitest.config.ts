import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'api-integration',
          root: './apps/api',
          include: ['test/**/*.spec.ts'],
          // Absolute, so the path means the same thing to Vitest (which resolves against the
          // project root) and to tooling that reads this file from the repository root.
          globalSetup: [
            resolve(import.meta.dirname, 'apps/api/test/setup/postgres.global-setup.ts'),
            resolve(import.meta.dirname, 'apps/api/test/setup/anvil.global-setup.ts'),
          ],
          // Starting a real PostgreSQL server and applying migrations happens once for the project;
          // each spec then clones the migrated template, which is a file copy.
          testTimeout: 60_000,
          hookTimeout: 180_000,
          // One Anvil instance is shared by every spec here, and the reorg suite rewrites its
          // history. Running the files in parallel would let one spec's fork land in the middle of
          // another's scan, so they run one at a time.
          fileParallelism: false,
        },
      },
      {
        test: {
          // A real TRON node, run locally in Docker, with a database beside it. Separate from
          // `api-integration` because that project must stay runnable with nothing but Node, and
          // separate from `chain-live` because nothing here touches the public internet. It is the
          // only place a TRON payment is driven by a transaction this suite actually broadcast.
          name: 'chain-local',
          root: './apps/api',
          include: ['local/**/*.spec.ts'],
          globalSetup: [
            resolve(import.meta.dirname, 'apps/api/test/setup/postgres.global-setup.ts'),
          ],
          // A witness produces a block only when there is a transaction to put in it, and
          // `broadcasttransaction` does not return until that block exists. TRON policy is nineteen
          // confirmations, so a payment reaching completion costs around two minutes of real block
          // production that cannot be hurried, and the budget has to cover the slowest of them.
          testTimeout: 600_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          // Reads a public test network over the internet, so it is excluded from `npm test` and
          // from `npm run test:integration`, and is run on demand. Nothing here spends anything:
          // every assertion is a read, and the transfers it checks already exist on the chain.
          name: 'chain-live',
          root: './apps/api',
          include: ['live/**/*.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          // The dashboard and checkout are covered end to end by Playwright, but the decisions that
          // broke the checkout page were pure functions applied to checkout data. A pure function
          // deserves a pure test, and this project needs no DOM to run one.
          name: 'web',
          root: './apps/web',
          include: ['src/**/*.spec.ts'],
        },
        // Next resolves this alias from tsconfig; Vitest does not read that file, so a module
        // imported through it resolves as a bare package name and fails.
        resolve: {
          alias: { '@': resolve(import.meta.dirname, 'apps/web/src') },
        },
      },
      {
        test: {
          name: 'tools',
          include: ['tools/**/*.spec.mjs'],
          // Each assertion boots ESLint against the real flat config and resolves every plugin.
          // That is the point of the suite, and it is slower than a unit test by design.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/index.ts', '**/main.*.ts'],
      // Thresholds are set per area rather than as one global number. The rules that decide whether
      // a payment completes are held at 100; a single average would let them rot behind easier code.
      // Branch floors sit below line floors because v8 branch counting is noisy around optional
      // chaining and default parameters, and equalising them manufactures failures.
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
        'packages/shared/src/payment-transition-table.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'packages/shared/src/payment-state-machine.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
});
