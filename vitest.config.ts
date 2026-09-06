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
