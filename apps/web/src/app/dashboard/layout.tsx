import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DashboardNavigation } from '@/components/dashboard-navigation';
import { QueryProvider } from '@/components/query-provider';
import { clearSession, readSession } from '@/lib/session';

/**
 * The shell every dashboard screen sits in.
 *
 * The environment is stated in the chrome rather than buried in a settings page, and it is derived
 * from the key's own prefix so the badge cannot disagree with what the requests actually do. A
 * merchant looking at live money should never have to work out which mode they are in.
 */

async function disconnect(): Promise<void> {
  'use server';

  await clearSession();
  redirect('/connect');
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (session === null) {
    redirect('/connect');
  }

  const isLive = session.environment === 'live';

  return (
    <div className="min-h-dvh bg-surface">
      <header className="sticky top-0 z-20 border-b border-border bg-surface-raised/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight text-text">
            CryptoPay
          </Link>

          <span
            title={
              isLive
                ? 'Live mode. These payments move real money.'
                : 'Test mode. A test key is physically unable to produce a mainnet payment.'
            }
            className={
              isLive
                ? 'rounded-full border border-status-canceled bg-status-canceled-soft px-2 py-0.5 text-xs font-medium text-status-canceled'
                : 'rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted'
            }
          >
            {isLive ? 'Live' : 'Test'}
          </span>

          <div className="flex-1" />

          <form action={disconnect}>
            <button
              type="submit"
              className="rounded-lg px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
            >
              Disconnect
            </button>
          </form>
        </div>

        <DashboardNavigation />
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <QueryProvider>{children}</QueryProvider>
      </main>
    </div>
  );
}
