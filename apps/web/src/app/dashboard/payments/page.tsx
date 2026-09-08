import { Suspense } from 'react';

import { Card } from '@/components/ui/surfaces';

import { PaymentsExplorer } from './_list/payments-explorer';
import { PaymentsTableSkeleton } from './_list/payments-table';

/**
 * The list reads its filters from the URL, so it must be a client component and it must sit behind a
 * Suspense boundary: `useSearchParams` opts the subtree out of static rendering, and without the
 * boundary that opt-out is the whole route.
 */

export const metadata = { title: 'Payments' };

export default function PaymentsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-text">Payments</h1>
        <p className="mt-1 text-sm text-text-muted">
          Every payment this key can see, newest first. A filtered view is a link you can send.
        </p>
      </div>

      <Suspense
        fallback={
          <Card>
            <PaymentsTableSkeleton />
          </Card>
        }
      >
        <PaymentsExplorer />
      </Suspense>
    </div>
  );
}
