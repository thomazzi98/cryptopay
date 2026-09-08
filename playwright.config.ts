import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the built application.
 *
 * The stack is started by `scripts/demo.mjs`, the same script a person runs to look at the interface,
 * so what is tested is what ships rather than a bespoke arrangement assembled for the tests. It
 * writes the merchant key to stdout, and the global setup reads it from there.
 *
 * No retries locally: a test that only passes on the second attempt is a test that is lying, and
 * finding that out on a developer's machine is cheaper than finding it out in CI. CI retries once,
 * because a genuinely flaky infrastructure failure there costs a full re-run of everything.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  workers: 1,
  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: process.env.CRYPTOPAY_WEB_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
