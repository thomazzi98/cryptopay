'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { WebhookDeliveryList } from '@cryptopay/shared';

import { callApi } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';

import { DeliveryRow } from './delivery-row';
import {
  DELIVERY_STATUS_ORDER,
  DELIVERY_STATUS_TONES,
  isAwaitingRetry,
  type DeliveryStatus,
} from './delivery-presentation';
import { errorDetail } from './error-detail';

const LIST_POLL_MILLISECONDS = 5000;

type StatusFilter = DeliveryStatus | 'all';

function listPath(filter: StatusFilter): string {
  if (filter === 'all') {
    return 'v1/webhooks/deliveries';
  }
  return `v1/webhooks/deliveries?status=${filter}`;
}

/** A retry lands without anyone asking, so the list keeps refetching while one is still owed. */
function shouldKeepPolling(page: WebhookDeliveryList | undefined): boolean {
  if (page === undefined) {
    return false;
  }
  return page.data.some((delivery) => isAwaitingRetry(delivery.status));
}

function StatusFilterControl({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      Status
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value as StatusFilter);
        }}
        className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-sm text-text"
      >
        <option value="all">All</option>
        {DELIVERY_STATUS_ORDER.map((status) => (
          <option key={status} value={status}>
            {DELIVERY_STATUS_TONES[status].label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DeliveryLog() {
  const [filter, setFilter] = useState<StatusFilter>('all');

  const deliveriesQuery = useQuery<WebhookDeliveryList, unknown>({
    queryKey: ['webhook-deliveries', filter],
    queryFn: () => callApi<WebhookDeliveryList>(listPath(filter)),
    refetchInterval: (query) =>
      shouldKeepPolling(query.state.data) ? LIST_POLL_MILLISECONDS : false,
  });

  return (
    <Card>
      <CardHeader
        title="Delivery log"
        description="Every callback sent for this environment. Redelivering keeps the same webhook-id, so a receiver that already processed the event will deduplicate it exactly as it does a retry."
        action={<StatusFilterControl value={filter} onChange={setFilter} />}
      />

      {deliveriesQuery.isPending && <SkeletonRows rows={6} />}

      {deliveriesQuery.isError && (
        <ErrorState
          title="The delivery log could not be loaded"
          detail={errorDetail(deliveriesQuery.error)}
          action={
            <Button
              onClick={() => {
                void deliveriesQuery.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      )}

      {deliveriesQuery.isSuccess && deliveriesQuery.data.data.length === 0 && (
        <EmptyState
          title={filter === 'all' ? 'No callbacks sent yet' : 'No callbacks with this status'}
          description={
            filter === 'all'
              ? 'A delivery appears here as soon as a payment with a callback URL changes status.'
              : 'Nothing in this environment currently has that delivery status. Clear the filter to see the rest.'
          }
        />
      )}

      {deliveriesQuery.isSuccess && deliveriesQuery.data.data.length > 0 && (
        <ul>
          {deliveriesQuery.data.data.map((delivery) => (
            <DeliveryRow key={delivery.identifier} delivery={delivery} />
          ))}
        </ul>
      )}
    </Card>
  );
}
