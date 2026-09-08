'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';
import { formatTimestamp } from '@/lib/format';

import {
  deliveriesQueryKey,
  describeFailure,
  fetchDeliveries,
  redeliverWebhook,
  type PaymentDeliverySummary,
} from './queries';

/**
 * The callbacks this payment produced, and the one control that repairs them.
 *
 * A merchant whose receiver was down does not need a diagnosis, they need the event again, so the
 * failure reason and the button that resends sit in the same row. Redelivery is offered for a
 * delivered event too: a merchant whose own database rolled back after acknowledging knows better
 * than this dashboard whether they still hold it. The identifier is stable across retries, which is
 * what makes a duplicate safe for a receiver that deduplicates on the webhook id.
 *
 * Deliveries keep retrying on their own schedule after a payment is final, so this panel polls even
 * when the payment above it has stopped moving.
 */

const DELIVERY_POLL_MILLISECONDS = 8000;

const DELIVERY_TONES: Readonly<Record<PaymentDeliverySummary['status'], string>> = Object.freeze({
  pending: 'border-border bg-surface-sunken text-text-muted',
  in_flight: 'border-status-confirming bg-status-confirming-soft text-status-confirming',
  delivered: 'border-status-completed bg-status-completed-soft text-status-completed',
  failed: 'border-status-underpaid bg-status-underpaid-soft text-status-underpaid',
  abandoned: 'border-status-canceled bg-status-canceled-soft text-status-canceled',
});

const DELIVERY_LABELS: Readonly<Record<PaymentDeliverySummary['status'], string>> = Object.freeze({
  pending: 'Queued',
  in_flight: 'Sending',
  delivered: 'Delivered',
  failed: 'Failed, will retry',
  abandoned: 'Abandoned',
});

function DeliveryRow({
  delivery,
  onRedelivered,
}: {
  delivery: PaymentDeliverySummary;
  onRedelivered: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => redeliverWebhook(delivery.identifier),
    onSuccess: () => {
      onRedelivered();
    },
  });

  return (
    <li className="border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-text">{delivery.eventType}</span>
            <span
              className={classNames(
                'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                DELIVERY_TONES[delivery.status],
              )}
            >
              {DELIVERY_LABELS[delivery.status]}
            </span>
            <span className="tabular rounded-full border border-border px-2 py-0.5 text-xs text-text-subtle">
              {delivery.attemptCount} attempts
            </span>
          </div>

          <p
            title={delivery.destinationUrl}
            className="mt-1.5 font-mono text-xs break-all text-text-muted"
          >
            {delivery.destinationUrl}
          </p>

          <p className="tabular mt-1 text-xs text-text-subtle">
            Queued {formatTimestamp(delivery.createdAt)}
            {delivery.deliveredAt !== null &&
              ` and delivered ${formatTimestamp(delivery.deliveredAt)}`}
          </p>
        </div>

        <Button
          size="small"
          loading={mutation.isPending}
          disabled={delivery.status === 'in_flight'}
          title={
            delivery.status === 'in_flight'
              ? 'An attempt is running right now.'
              : 'Queue this event to be sent again.'
          }
          onClick={() => {
            mutation.mutate();
          }}
        >
          Send again
        </Button>
      </div>

      {delivery.lastFailure !== null && (
        <p className="mt-3 rounded-lg border border-border bg-surface-sunken px-3 py-2 font-mono text-xs break-all text-status-canceled">
          {delivery.lastFailure}
        </p>
      )}

      {mutation.error !== null && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-border bg-status-canceled-soft px-3 py-2 text-xs text-status-canceled"
        >
          {describeFailure(mutation.error)}
        </p>
      )}
    </li>
  );
}

export function DeliveriesPanel({ paymentIdentifier }: { paymentIdentifier: string }) {
  const queryClient = useQueryClient();
  const queryKey = deliveriesQueryKey(paymentIdentifier);

  const deliveriesQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchDeliveries(paymentIdentifier, signal),
    refetchInterval: DELIVERY_POLL_MILLISECONDS,
  });

  if (deliveriesQuery.isPending) {
    return <SkeletonRows rows={3} />;
  }

  if (deliveriesQuery.isError) {
    return (
      <ErrorState
        title="The deliveries could not be loaded"
        detail={describeFailure(deliveriesQuery.error)}
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
    );
  }

  const deliveries = deliveriesQuery.data;

  if (deliveries.length === 0) {
    return (
      <EmptyState
        title="No callbacks for this payment"
        description="Nothing has been sent yet. A payment with no callback URL never produces one, and a payment that has not changed status has nothing to announce."
      />
    );
  }

  return (
    <ul>
      {deliveries.map((delivery) => (
        <DeliveryRow
          key={delivery.identifier}
          delivery={delivery}
          onRedelivered={() => {
            void queryClient.invalidateQueries({ queryKey });
          }}
        />
      ))}
    </ul>
  );
}
