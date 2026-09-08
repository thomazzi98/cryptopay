import { expect, test } from '@playwright/test';

/**
 * The dashboard, driven in a browser.
 *
 * These assertions are the ones curl cannot make. Every screen here fetches through the proxy after
 * hydration, so the server HTML is a skeleton and the content only exists once JavaScript has run;
 * a request-level check would pass against a page that renders nothing.
 *
 * The API key is read from the environment, where `scripts/demo.mjs --exec` puts it. It is set as a
 * cookie directly rather than typed into the form, because the form is exercised by its own test and
 * every other test should not depend on it.
 */

const API_KEY = process.env.CRYPTOPAY_API_KEY ?? '';
const API_URL = process.env.CRYPTOPAY_API_URL ?? 'http://127.0.0.1:3001';

interface CreatedPayment {
  readonly identifier: string;
  readonly receivingAccount: string;
  readonly checkoutUrl: string;
  readonly requestedAmount: { readonly display: string };
}

async function createPayment(reference: string, amount = '25.00'): Promise<CreatedPayment> {
  const response = await fetch(`${API_URL}/v1/payments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-${reference}`,
    },
    body: JSON.stringify({
      amount,
      assetSymbol: 'USDC',
      network: 'polygon-amoy',
      merchantReference: reference,
      callbackUrl: 'https://hooks.merchant.example/cryptopay',
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not create a payment: ${response.status.toString()}`);
  }
  return (await response.json()) as CreatedPayment;
}

test.beforeEach(async ({ context }) => {
  expect(API_KEY, 'CRYPTOPAY_API_KEY must be set; run through scripts/demo.mjs --exec').not.toBe(
    '',
  );
  await context.addCookies([
    {
      name: 'cryptopay_key',
      value: API_KEY,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
});

test.describe('connecting', () => {
  test('refuses something that is not a CryptoPay key, and says why', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/connect');

    await page.getByLabel('API key').fill('not-a-key');
    await page.getByRole('button', { name: 'Connect' }).click();

    // The form's own message, not getByRole('alert'): Next's route announcer is also role="alert".
    await expect(page.locator('#apiKeyError')).toContainText('cp_test_');
    await expect(page).toHaveURL(/\/connect/);
  });

  test('accepts a real key and lands on the dashboard', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/connect');

    await page.getByLabel('API key').fill(API_KEY);
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
  });

  /**
   * The key is held in an httpOnly cookie so that no script on the page can read it. If this ever
   * fails, any injected script can create live payments.
   */
  test('never exposes the key to page JavaScript', async ({ page }) => {
    await page.goto('/dashboard');
    const visibleToScripts = await page.evaluate(() => document.cookie);
    expect(visibleToScripts).not.toContain('cp_test_');
    expect(visibleToScripts).not.toContain(API_KEY.slice(0, 20));
  });
});

test.describe('the payments list', () => {
  test('renders rows for payments that exist', async ({ page }) => {
    const payment = await createPayment('e2e-list-one');
    await page.goto('/dashboard/payments');

    // The table elides the identifier for scanning and carries the whole value in the title, which
    // is what someone pastes elsewhere.
    await expect(page.getByTitle(payment.identifier).first()).toBeVisible();
    await expect(page.getByText('e2e-list-one').first()).toBeVisible();
  });

  /**
   * A filter that is only component state is a filter that a reload discards and a colleague cannot
   * be sent. Both halves are checked: the URL carries it, and a reload keeps it.
   */
  test('keeps a filter in the URL across a reload', async ({ page }) => {
    await createPayment('e2e-filter');
    await page.goto('/dashboard/payments');

    await page.getByLabel(/status/i).selectOption('pending');
    await expect(page).toHaveURL(/status=pending/);

    await page.reload();
    await expect(page.getByLabel(/status/i)).toHaveValue('pending');
  });

  test('takes a row through to the payment', async ({ page }) => {
    const payment = await createPayment('e2e-navigate');
    await page.goto('/dashboard/payments');

    await page.locator(`a[href="/dashboard/payments/${payment.identifier}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(payment.identifier));
  });
});

test.describe('a payment', () => {
  /**
   * The two guarantees must be legible as two. A merchant who reads a full confirmation meter as
   * "final" ships goods against a block a reorg can still take back.
   */
  test('shows the confirmation meter and the finality state separately', async ({ page }) => {
    const payment = await createPayment('e2e-guarantees');
    await page.goto(`/dashboard/payments/${payment.identifier}`);

    await expect(page.getByRole('progressbar', { name: /confirmations/i })).toBeVisible();
    await expect(page.getByText(/finality/i).first()).toBeVisible();
  });

  test('shows the amount and the address it allocated', async ({ page }) => {
    const payment = await createPayment('e2e-amounts', '42.50');
    await page.goto(`/dashboard/payments/${payment.identifier}`);

    await expect(page.getByText('42.50').first()).toBeVisible();
    await expect(page.getByTitle(payment.receivingAccount).first()).toBeVisible();
  });

  test('offers the tabs and keeps the chosen one in the URL', async ({ page }) => {
    const payment = await createPayment('e2e-tabs');
    await page.goto(`/dashboard/payments/${payment.identifier}`);

    const transfers = page.getByRole('tab', { name: /transfers/i });
    await expect(transfers).toBeVisible();
    await transfers.click();

    await expect(transfers).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=transfers/);
  });

  /**
   * An empty state and a failed load must never look the same. A merchant seeing "no transfers yet"
   * when the truth is "we could not read them" concludes they have lost money.
   */
  test('says a payment has no transfers rather than showing nothing', async ({ page }) => {
    const payment = await createPayment('e2e-empty-transfers');
    await page.goto(`/dashboard/payments/${payment.identifier}?tab=transfers`);

    await expect(
      page.getByText(/no transfers|nothing has arrived|not received/i).first(),
    ).toBeVisible();
  });
});

test.describe('every screen', () => {
  const screens = [
    ['/dashboard', /overview|payments created|system health/i],
    ['/dashboard/payments', /payments/i],
    ['/dashboard/webhooks', /deliver|callback|webhook/i],
    ['/dashboard/simulator', /simulat|create/i],
    ['/dashboard/integration', /integrat|quick start|curl/i],
    ['/dashboard/settings', /merchant|tolerance|environment/i],
  ] as const;

  for (const [path, expected] of screens) {
    test(`renders ${path} without a console error`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          errors.push(message.text());
        }
      });
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });

      await page.goto(path);
      await expect(page.getByText(expected).first()).toBeVisible();
      expect(errors, `console errors on ${path}`).toEqual([]);
    });
  }

  /**
   * Rendered at a phone width because a merchant checking a payment on their phone is the ordinary
   * case, not an edge one. A page that scrolls sideways has a layout that is wrong.
   */
  test('does not scroll sideways at 360 pixels wide', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    for (const [path] of screens) {
      await page.goto(path);
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${path} scrolls sideways at 360px`).toBe(false);
    }
  });
});
