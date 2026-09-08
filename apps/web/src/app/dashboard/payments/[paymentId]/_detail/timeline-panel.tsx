'use client';

import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { describeStatus } from '@/lib/payment-status';

import { describeFailure, fetchTimeline, readPaymentStatus, timelineQueryKey } from './queries';
import { useNow } from './use-now';

/**
 * The audit trail, one entry per transition that actually happened.
 *
 * Nothing is synthesised here. There is no "created" row, no "waiting" row and no interpolation
 * between two entries: a timeline that invents steps is a timeline nobody can reconcile against the
 * webhooks they received. The dot takes the colour of the status the payment moved to, so the
 * sequence reads as the same colours the badges use everywhere else.
 */
export function TimelinePanel({
  paymentIdentifier,
  pollIntervalMilliseconds,
}: {
  paymentIdentifier: string;
  pollIntervalMilliseconds: number | false;
}) {
  const now = useNow();
  const timelineQuery = useQuery({
    queryKey: timelineQueryKey(paymentIdentifier),
    queryFn: ({ signal }) => fetchTimeline(paymentIdentifier, signal),
    refetchInterval: pollIntervalMilliseconds,
  });

  const timeline = timelineQuery.data;

  // A failed refetch keeps the last good timeline, so the failure replaces the list only when there
  // is no list to keep.
  if (timeline === undefined && timelineQuery.isError) {
    return (
      <ErrorState
        title="The timeline could not be loaded"
        detail={describeFailure(timelineQuery.error)}
        action={
          <Button
            onClick={() => {
              void timelineQuery.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (timeline === undefined) {
    return <SkeletonRows rows={4} />;
  }

  const entries = timeline.toSorted((first, second) => first.statusVersion - second.statusVersion);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No transitions yet"
        description="This payment has not changed status since it was created. Every future change is recorded here as it happens."
      />
    );
  }

  return (
    <ol className="px-5 py-5">
      {entries.map((entry, index) => {
        const toStatus = readPaymentStatus(entry.toStatus);
        const fromStatus = entry.fromStatus === null ? null : readPaymentStatus(entry.fromStatus);
        const isLast = index === entries.length - 1;

        return (
          <li key={`${entry.statusVersion}-${entry.occurredAt}`} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className="mt-1.5 size-3 shrink-0 rounded-full ring-4 ring-surface-raised"
                style={{
                  backgroundColor:
                    toStatus === null ? 'var(--color-text-subtle)' : describeStatus(toStatus).token,
                }}
              />
              {!isLast && <span aria-hidden="true" className="w-px flex-1 bg-border" />}
            </div>

            <div className={isLast ? 'min-w-0 flex-1' : 'min-w-0 flex-1 pb-6'}>
              <div className="flex flex-wrap items-center gap-2">
                {toStatus === null ? (
                  <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
                    {entry.toStatus}
                  </span>
                ) : (
                  <StatusBadge status={toStatus} />
                )}
                {fromStatus !== null && (
                  <span className="text-xs text-text-subtle">
                    from {describeStatus(fromStatus).label.toLowerCase()}
                  </span>
                )}
                <span className="tabular rounded-full border border-border px-2 py-0.5 text-xs text-text-subtle">
                  v{entry.statusVersion}
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  title="What drove the transition"
                  className="font-mono text-xs break-all text-text-muted"
                >
                  {entry.trigger}
                </span>
                <span className="tabular text-xs text-text-subtle">
                  {formatTimestamp(entry.occurredAt)}
                </span>
                {now !== null && (
                  <span className="tabular text-xs text-text-subtle">
                    {formatRelative(entry.occurredAt, now)}
                  </span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
