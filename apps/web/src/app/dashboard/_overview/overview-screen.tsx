'use client';

import type { PaymentList } from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonRows,
} from '@/components/ui/surfaces';
import { ApiError, callApi } from '@/lib/api-client';

import { HealthStrip } from './health-strip';
import { KpiRow, KpiRowSkeleton } from './kpi-row';
import { buildOverview } from './metrics';
import { fetchReadiness } from './readiness';
import { RecentPayments } from './recent-payments';
import { StatusDistribution } from './status-distribution';

/**
 * One page of payments feeds the whole screen. There is no analytics endpoint, so the alternative to
 * deriving these figures here would be inventing an endpoint or inventing the figures, and the page
 * says in plain text which payments it counted rather than implying it counted all of them.
 *
 * Two polls, at two rates, because the data moves at two rates: a payment list changes as customers
 * pay, and a readiness report changes when an operator or a chain does something.
 *
 * A failed poll keeps the data the last successful one returned, so a failure may only replace the
 * screen when there is nothing behind it. Otherwise it is said over figures that are still real:
 * telling a merchant the overview could not be built while a correct overview is on screen is false.
 */

const PAYMENTS_REFETCH_MILLISECONDS = 15_000;
const READINESS_REFETCH_MILLISECONDS = 30_000;
const CLOCK_TICK_MILLISECONDS = 30_000;

const DISTRIBUTION_DESCRIPTION =
  'Every status present in the payments counted here, not only the last 7 days.';
const RECENT_DESCRIPTION = 'The ten most recently created.';

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request failed and said nothing about why.';
}

function StaleDataBanner({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-health-degraded bg-health-degraded-soft px-3 py-2 text-xs text-health-degraded"
    >
      <p className="min-w-0">
        <span className="font-medium">{message}</span> {detail}
      </p>
      <Button size="small" onClick={onRetry}>
        Refresh
      </Button>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <KpiRowSkeleton />
      <Skeleton className="h-3 w-full max-w-lg" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Status distribution" description={DISTRIBUTION_DESCRIPTION} />
          <SkeletonRows rows={4} />
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Recent payments" description={RECENT_DESCRIPTION} />
          <SkeletonRows rows={6} />
        </Card>
      </div>
    </>
  );
}

export function OverviewScreen() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MILLISECONDS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const payments = useQuery({
    queryKey: ['overview', 'payments'],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      callApi<PaymentList>('v1/payments?limit=100', { signal }),
    refetchInterval: PAYMENTS_REFETCH_MILLISECONDS,
  });

  const readiness = useQuery({
    queryKey: ['overview', 'readiness'],
    queryFn: () => fetchReadiness(),
    refetchInterval: READINESS_REFETCH_MILLISECONDS,
  });

  const paymentsData = payments.data;
  const metrics = useMemo(() => {
    if (paymentsData === undefined) {
      return null;
    }
    return buildOverview(paymentsData.data, paymentsData.hasMore, now);
  }, [paymentsData, now]);

  const readinessReport = readiness.data;
  const paymentsFailure = payments.isError ? describeFailure(payments.error) : null;
  const readinessFailure = readiness.isError ? describeFailure(readiness.error) : null;

  return (
    <div className="space-y-6">
      {paymentsFailure !== null && metrics !== null && (
        <StaleDataBanner
          message="These figures are the ones from the last successful load; the latest refresh failed."
          detail={paymentsFailure}
          onRetry={() => {
            void payments.refetch();
          }}
        />
      )}

      {payments.isPending && <OverviewSkeleton />}

      {paymentsFailure !== null && metrics === null && (
        <Card>
          <ErrorState
            title="The overview could not be built"
            detail={paymentsFailure}
            action={
              <Button
                onClick={() => {
                  void payments.refetch();
                }}
              >
                Try again
              </Button>
            }
          />
        </Card>
      )}

      {metrics !== null && metrics.recent.length === 0 && (
        <Card>
          <EmptyState
            title="No payments yet"
            description="Once a payment is created on this key, the figures, the status distribution and the recent activity on this screen fill in from it."
            action={
              <Link
                href="/dashboard/simulator"
                className="inline-flex items-center rounded-lg border border-transparent bg-accent px-3.5 py-2 text-sm font-medium text-text-inverted transition-colors hover:bg-accent-hover"
              >
                Open the simulator
              </Link>
            }
          />
        </Card>
      )}

      {metrics !== null && metrics.recent.length > 0 && (
        <>
          <KpiRow kpis={metrics.kpis} />
          <p className="text-xs text-text-subtle">
            {metrics.windowNote} Comparisons are against the seven days before last.
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader title="Status distribution" description={DISTRIBUTION_DESCRIPTION} />
              <CardBody>
                <StatusDistribution distribution={metrics.distribution} />
              </CardBody>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader
                title="Recent payments"
                description={RECENT_DESCRIPTION}
                action={
                  <Link
                    href="/dashboard/payments"
                    className="text-sm font-medium text-accent hover:underline"
                  >
                    All payments
                  </Link>
                }
              />
              <RecentPayments payments={metrics.recent} now={now} />
            </Card>
          </div>
        </>
      )}

      <Card>
        <CardHeader
          title="System health"
          description="Read from the API readiness endpoint. A halted network still answers requests, so it is reported here rather than as an outage."
        />
        {readiness.isPending && (
          <CardBody className="space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-9 w-full" />
            <SkeletonRows rows={3} className="p-0" />
          </CardBody>
        )}
        {readinessFailure !== null && readinessReport === undefined && (
          <ErrorState
            title="Readiness could not be read"
            detail={readinessFailure}
            action={
              <Button
                onClick={() => {
                  void readiness.refetch();
                }}
              >
                Try again
              </Button>
            }
          />
        )}
        {readinessReport !== undefined && (
          <CardBody className="space-y-4">
            {readinessFailure !== null && (
              <StaleDataBanner
                message="This report is the last one that was read; the latest check failed."
                detail={readinessFailure}
                onRetry={() => {
                  void readiness.refetch();
                }}
              />
            )}
            <HealthStrip report={readinessReport} />
          </CardBody>
        )}
      </Card>
    </div>
  );
}
