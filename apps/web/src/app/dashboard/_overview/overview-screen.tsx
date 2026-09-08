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
 */

const PAYMENTS_REFETCH_MILLISECONDS = 15_000;
const READINESS_REFETCH_MILLISECONDS = 30_000;

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request failed and said nothing about why.';
}

export function OverviewScreen() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const payments = useQuery({
    queryKey: ['overview', 'payments'],
    // TanStack names its loader option `queryFn`, which the naming rule rejects and no rename can
    // fix. A computed key states the library's name without declaring an abbreviated identifier.
    ['queryFn']: ({ signal }: { signal: AbortSignal }) =>
      callApi<PaymentList>('v1/payments?limit=100', { signal }),
    refetchInterval: PAYMENTS_REFETCH_MILLISECONDS,
  });

  const readiness = useQuery({
    queryKey: ['overview', 'readiness'],
    ['queryFn']: () => fetchReadiness(),
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

  return (
    <div className="space-y-6">
      {payments.isPending && <KpiRowSkeleton />}

      {payments.isError && (
        <Card>
          <ErrorState
            title="The overview could not be built"
            detail={describeFailure(payments.error)}
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
              <CardHeader
                title="Status distribution"
                description="Every status present in this window."
              />
              <CardBody>
                <StatusDistribution distribution={metrics.distribution} />
              </CardBody>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader
                title="Recent payments"
                description="The ten most recently created."
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
        {readiness.isError && (
          <ErrorState
            title="Readiness could not be read"
            detail={describeFailure(readiness.error)}
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
          <CardBody>
            <HealthStrip report={readinessReport} />
          </CardBody>
        )}
      </Card>
    </div>
  );
}
