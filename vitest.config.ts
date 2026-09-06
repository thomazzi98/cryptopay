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
          name: 'tools',
          include: ['tools/**/*.spec.mjs'],
          // Each assertion boots ESLint against the real flat config and resolves every plugin.
          // That is the point of the suite, and it is slower than a unit test by design.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
