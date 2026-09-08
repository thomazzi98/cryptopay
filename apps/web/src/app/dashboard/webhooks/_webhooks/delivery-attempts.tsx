'use client';

import { useQuery } from '@tanstack/react-query';
import type { WebhookAttempt, WebhookDelivery } from '@cryptopay/shared';

import { callApi } from '@/lib/api-client';
import { formatTimestamp } from '@/lib/format';
import { Copyable, Field } from '@/components/ui/data';
import { ErrorState, Skeleton } from '@/components/ui/surfaces';

import { AllowlistNotice, AttemptOutcomeBadge } from './badges';
import { errorDetail } from './error-detail';
import { isAwaitingRetry, type DeliveryStatus } from './delivery-presentation';
import { RefreshFailureBanner } from './refresh-failure-banner';

const ATTEMPT_POLL_MILLISECONDS = 5000;

function AttemptCard({ attempt }: { attempt: WebhookAttempt }) {
  return (
    <li className="rounded-lg border border-border bg-surface-sunken px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="tabular text-sm font-semibold text-text">
          Attempt {attempt.attemptNumber.toString()}
        </span>
        <AttemptOutcomeBadge outcome={attempt.outcome} />
        <span className="tabular text-xs text-text-subtle">
          {formatTimestamp(attempt.requestedAt)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Response">
          <span className="tabular">
            {attempt.responseStatus === null ? 'no response' : attempt.responseStatus.toString()}
          </span>
        </Field>
        <Field label="Took">
          <span className="tabular">{attempt.durationMilliseconds.toString()} ms</span>
        </Field>
        <Field label="Pinned address" className="col-span-2">
          {attempt.resolvedAddress === null ? (
            <span className="text-text-subtle">not resolved</span>
          ) : (
            <Copyable value={attempt.resolvedAddress} display={attempt.resolvedAddress} />
          )}
        </Field>
      </dl>

      {attempt.failureReason !== null && (
        <p className="mt-3 text-sm text-health-failed">{attempt.failureReason}</p>
      )}

      {attempt.responseSnippet !== null && (
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-text-muted">
          {attempt.responseSnippet}
        </pre>
      )}

      {attempt.usedPrivateAllowlist && (
        <div className="mt-3">
          <AllowlistNotice />
        </div>
      )}
    </li>
  );
}

export function DeliveryAttempts({
  deliveryIdentifier,
  status,
}: {
  deliveryIdentifier: string;
  status: DeliveryStatus;
}) {
  const detailQuery = useQuery<WebhookDelivery, unknown>({
    queryKey: ['webhook-delivery', deliveryIdentifier],
    queryFn: () => callApi<WebhookDelivery>(`v1/webhooks/deliveries/${deliveryIdentifier}`),
    refetchInterval: isAwaitingRetry(status) ? ATTEMPT_POLL_MILLISECONDS : false,
  });

  const delivery = detailQuery.data;
  const failure = detailQuery.isError ? errorDetail(detailQuery.error) : null;

  function retry(): void {
    void detailQuery.refetch();
  }

  if (delivery === undefined) {
    if (failure === null) {
      return (
        <div className="space-y-2 px-5 py-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }
    return <ErrorState title="The attempts could not be loaded" detail={failure} />;
  }

  const ordered = delivery.attempts.toSorted(
    (first, second) => first.attemptNumber - second.attemptNumber,
  );

  return (
    <div>
      {failure !== null && <RefreshFailureBanner detail={failure} onRetry={retry} />}

      {ordered.length === 0 ? (
        <p className="px-5 py-6 text-sm text-text-muted">
          No attempt has been made yet. This delivery is still queued.
        </p>
      ) : (
        <ul className="space-y-2 px-5 py-4">
          {ordered.map((attempt) => (
            <AttemptCard key={attempt.attemptNumber} attempt={attempt} />
          ))}
        </ul>
      )}
    </div>
  );
}
