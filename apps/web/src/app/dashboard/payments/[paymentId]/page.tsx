import { Suspense } from 'react';

import { PaymentDetail } from './_detail/payment-detail';
import { DetailSkeleton } from './_detail/detail-skeleton';

/**
 * Nothing here is server rendered. A payment's status, confirmations and finality are what this
 * screen is for and all three change while it is open, so a value baked into the first paint would
 * be stale before it was read.
 *
 * The detail view reads its selected tab from the URL, which opts the subtree out of static
 * rendering; without this Suspense boundary that opt-out would take the whole route with it.
 */

export const metadata = { title: 'Payment' };

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ paymentId: string }>;
}) {
  const { paymentId } = await params;

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <PaymentDetail paymentIdentifier={paymentId} />
    </Suspense>
  );
}
