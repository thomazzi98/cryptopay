'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { WebhookDelivery } from '@cryptopay/shared';

import { callApi } from '@/lib/api-client';
import { classNames } from '@/lib/class-names';
import { formatTimestamp } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';

import { DeliveryAttempts } from './delivery-attempts';
import { DeliveryStatusBadge } from './badges';
import { NextAttemptCountdown } from './next-attempt-countdown';
import { errorDetail } from './error-detail';

/** Enough of the destination to recognise it, without letting a long path push the row apart. */
function destinationLabel(destinationUrl: string): string {
  try {
    const parsed = new URL(destinationUrl);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return destinationUrl;
  }
}

export function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const redeliver = useMutation<WebhookDelivery, unknown, void>({
    mutationFn: () =>
      callApi<WebhookDelivery>(`v1/webhooks/deliveries/${delivery.identifier}/redeliver`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
      await queryClient.invalidateQueries({ queryKey: ['webhook-delivery', delivery.identifier] });
    },
  });

  const isInFlight = delivery.status === 'in_flight';

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-4">
        <button
          type="button"
          onClick={() => {
            setExpanded((open) => !open);
          }}
          aria-expanded={expanded}
          className={classNames(
            'mt-0.5 rounded-lg border border-border px-2 py-0.5 font-mono text-xs',
            'text-text-muted transition-colors hover:bg-surface-hover hover:text-text',
          )}
        >
          {expanded ? '-' : '+'}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-text">{delivery.eventType}</span>
            <DeliveryStatusBadge status={delivery.status} />
            <span className="tabular text-xs text-text-subtle">
              {delivery.attemptCount.toString()}{' '}
              {delivery.attemptCount === 1 ? 'attempt' : 'attempts'}
            </span>
          </div>

          <p className="mt-1 truncate text-sm text-text-muted" title={delivery.destinationUrl}>
            {destinationLabel(delivery.destinationUrl)}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-subtle">
            <span className="tabular">{formatTimestamp(delivery.createdAt)}</span>
            <Copyable value={delivery.paymentIdentifier} />
            {delivery.nextAttemptAt !== null && (
              <NextAttemptCountdown nextAttemptAt={delivery.nextAttemptAt} />
            )}
          </div>

          {delivery.lastFailure !== null && (
            <p className="mt-2 text-sm text-status-underpaid">{delivery.lastFailure}</p>
          )}

          {redeliver.isError && (
            <p role="alert" className="mt-2 text-sm text-status-canceled">
              {errorDetail(redeliver.error)}
            </p>
          )}

          {redeliver.isSuccess && (
            <p className="mt-2 text-sm text-status-completed">
              Queued again. The webhook-id is unchanged, so a receiver that already processed it
              will deduplicate on the identifier it stored.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Copyable value={delivery.identifier} />
          <Button
            size="small"
            loading={redeliver.isPending}
            disabled={isInFlight}
            title={
              isInFlight
                ? 'An attempt is running right now. The API refuses a redelivery until it finishes.'
                : 'Send this event again. The webhook-id stays the same.'
            }
            onClick={() => {
              redeliver.mutate();
            }}
          >
            Redeliver
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-surface">
          <DeliveryAttempts deliveryIdentifier={delivery.identifier} status={delivery.status} />
        </div>
      )}
    </li>
  );
}
