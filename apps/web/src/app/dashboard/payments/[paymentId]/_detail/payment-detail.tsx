'use client';

import type { Payment } from '@cryptopay/shared';
import { allowedTargetsFrom, isTerminalPaymentStatus } from '@cryptopay/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, ErrorState } from '@/components/ui/surfaces';

import { CancelControl } from './cancel-control';
import { DeliveriesPanel } from './deliveries-panel';
import { DetailSkeleton } from './detail-skeleton';
import { GuaranteesPanel } from './guarantees-panel';
import { PaymentHeader } from './payment-header';
import {
  describeFailure,
  fetchPayment,
  paymentQueryKey,
  readPaymentStatus,
  timelineQueryKey,
  transfersQueryKey,
} from './queries';
import { RawPanel } from './raw-panel';
import { TabPanel, TabStrip, isTabId, type TabId } from './tabs';
import { TimelinePanel } from './timeline-panel';
import { TransfersPanel } from './transfers-panel';

/**
 * The reference view of one payment.
 *
 * Polling stops at a terminal status rather than running forever: nothing about a completed or
 * expired payment can change again, and a dashboard left open on one should not keep a request per
 * four seconds pointed at the API for the rest of the day. Until then the payment, its timeline and
 * its transfers all refresh, because a confirmation arriving is precisely what the reader is
 * waiting for.
 *
 * The selected tab lives in the URL. A merchant who sends a colleague a link to the webhooks of a
 * failing payment should be sending them the webhooks of that payment, not the timeline.
 */

const LIVE_POLL_MILLISECONDS = 4000;
const DEFAULT_TAB: TabId = 'timeline';

/** A terminal payment cannot change again, so the polling stops rather than running all day. */
function pollIntervalFor(payment: Payment | undefined): number | false {
  if (payment === undefined) {
    return false;
  }
  const status = readPaymentStatus(payment.status);
  if (status === null) {
    return false;
  }
  return isTerminalPaymentStatus(status) ? false : LIVE_POLL_MILLISECONDS;
}

export function PaymentDetail({ paymentIdentifier }: { paymentIdentifier: string }) {
  const searchParameters = useSearchParams();
  const queryClient = useQueryClient();

  const requestedTab = searchParameters.get('tab');
  const selectedTab = requestedTab !== null && isTabId(requestedTab) ? requestedTab : DEFAULT_TAB;

  const paymentQuery = useQuery({
    queryKey: paymentQueryKey(paymentIdentifier),
    queryFn: ({ signal }) => fetchPayment(paymentIdentifier, signal),
    refetchInterval: (query) => pollIntervalFor(query.state.data),
  });

  const payment = paymentQuery.data;
  const status = payment === undefined ? null : readPaymentStatus(payment.status);
  const pollIntervalMilliseconds = pollIntervalFor(payment);
  const isLive = pollIntervalMilliseconds !== false;
  const canCancel = status !== null && allowedTargetsFrom(status).includes('canceled');

  // The History API rather than the router: Next keeps useSearchParams in step with it, and changing
  // a tab is not a navigation. Going through the router would re-run the route and scroll the page.
  function selectTab(tab: TabId): void {
    const parameters = new URLSearchParams(searchParameters.toString());
    parameters.set('tab', tab);
    history.replaceState(null, '', `?${parameters.toString()}`);
  }

  function acceptCancellation(canceled: Payment): void {
    queryClient.setQueryData(paymentQueryKey(paymentIdentifier), canceled);
    void queryClient.invalidateQueries({ queryKey: timelineQueryKey(paymentIdentifier) });
    void queryClient.invalidateQueries({ queryKey: transfersQueryKey(paymentIdentifier) });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard/payments"
          className="rounded-lg text-sm text-text-muted transition-colors hover:text-text"
        >
          Back to payments
        </Link>
        {isLive && (
          <p className="flex items-center gap-2 text-xs text-text-subtle">
            <span
              aria-hidden="true"
              className="animate-status-pulse size-1.5 rounded-full bg-accent"
            />
            Refreshing while this payment is still moving
          </p>
        )}
      </div>

      {paymentQuery.isPending && <DetailSkeleton />}

      {paymentQuery.isError && (
        <Card>
          <ErrorState
            title="This payment could not be loaded"
            detail={describeFailure(paymentQuery.error)}
            action={
              <Button
                onClick={() => {
                  void paymentQuery.refetch();
                }}
              >
                Try again
              </Button>
            }
          />
        </Card>
      )}

      {payment !== undefined && (
        <>
          <PaymentHeader
            payment={payment}
            status={status}
            action={
              canCancel ? (
                <CancelControl
                  paymentIdentifier={paymentIdentifier}
                  onCanceled={acceptCancellation}
                />
              ) : null
            }
          />

          <GuaranteesPanel payment={payment} />

          <Card>
            <TabStrip selected={selectedTab} onSelect={selectTab} />

            <TabPanel tab="timeline" selected={selectedTab}>
              <TimelinePanel
                paymentIdentifier={paymentIdentifier}
                pollIntervalMilliseconds={pollIntervalMilliseconds}
              />
            </TabPanel>

            <TabPanel tab="transfers" selected={selectedTab}>
              <TransfersPanel
                paymentIdentifier={paymentIdentifier}
                pollIntervalMilliseconds={pollIntervalMilliseconds}
              />
            </TabPanel>

            <TabPanel tab="webhooks" selected={selectedTab}>
              <DeliveriesPanel paymentIdentifier={paymentIdentifier} />
            </TabPanel>

            <TabPanel tab="raw" selected={selectedTab}>
              <RawPanel payment={payment} />
            </TabPanel>
          </Card>
        </>
      )}
    </div>
  );
}
