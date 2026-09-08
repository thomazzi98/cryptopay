import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/surfaces';
import { environmentOf, readSession, writeSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Connect' };

/**
 * There are no accounts, no passwords and no users table.
 *
 * The dashboard authenticates the same way a merchant's own server does, with an API key, which is
 * both smaller than a login system and a stronger claim about the public API: anything visible here
 * is reachable by any merchant with the same key. It also means there is no password to leak.
 *
 * The key is stored in an httpOnly cookie by the action below and attached by the proxy, so it never
 * reaches the browser bundle.
 */

async function connect(formData: FormData): Promise<void> {
  'use server';

  const submitted = formData.get('apiKey');
  const apiKey = typeof submitted === 'string' ? submitted.trim() : '';
  if (environmentOf(apiKey) === null) {
    redirect('/connect?error=format');
  }

  await writeSession(apiKey);
  redirect('/dashboard');
}

export default async function ConnectPage({
  searchParams,
}: {
  // A Promise in Next 16. Awaiting it is not optional.
  searchParams: Promise<{ error?: string }>;
}) {
  const [session, query] = await Promise.all([readSession(), searchParams]);
  if (session !== null) {
    redirect('/dashboard');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-16">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-text">CryptoPay</h1>
        <p className="mt-2 text-sm text-text-muted">
          Accept USDC on Polygon. Every payment is verified against the chain by the backend, never
          by the browser.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-4">
          <form action={connect} className="space-y-4">
            <div>
              <label htmlFor="apiKey" className="block text-sm font-medium text-text">
                API key
              </label>
              <p className="mt-1 text-sm text-text-muted">
                The same key your server would use. It is kept in an httpOnly cookie and attached
                server-side, so it never reaches this page&apos;s JavaScript.
              </p>
              <input
                id="apiKey"
                name="apiKey"
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="cp_test_…"
                aria-describedby={query.error === undefined ? undefined : 'apiKeyError'}
                className="tabular mt-3 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
              />
            </div>

            {query.error !== undefined && (
              <p id="apiKeyError" role="alert" className="text-sm text-status-canceled">
                That does not look like a CryptoPay key. A key starts with{' '}
                <code className="font-mono">cp_test_</code> or{' '}
                <code className="font-mono">cp_live_</code>.
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full">
              Connect
            </Button>
          </form>

          <p className="border-t border-border pt-4 text-xs text-text-muted">
            A <code className="font-mono">cp_test_</code> key can only ever produce testnet
            payments. That separation is enforced by a database constraint, not by this form.
          </p>
        </CardBody>
      </Card>
    </main>
  );
}
