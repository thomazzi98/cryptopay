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
          // Reads a public test network over the internet, so it is excluded from `npm test` and
          // from `npm run test:integration`, and is run on demand. Nothing here spends anything:
          // every assertion is a read, and the transfers it checks already exist on the chain.
          name: 'tron-live',
          root: './apps/api',
          include: ['live/tron/**/*.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
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
