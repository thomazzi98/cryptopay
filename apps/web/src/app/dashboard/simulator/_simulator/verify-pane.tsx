'use client';

import type { Payment, WebhookAttempt } from '@cryptopay/shared';
import type { ReactNode } from 'react';

import { Amount, Copyable } from '@/components/ui/data';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  SkeletonRows,
} from '@/components/ui/surfaces';
import { formatTimestamp } from '@/lib/format';

import { buildConsoleEntries, type ConsoleEntry } from './console-entries';
import {
  classificationTone,
  networkLabel,
  observationTone,
  outcomeTone,
  PaymentStatusView,
  readErrorDetail,
} from './presentation';
import {
  useDeliveriesQuery,
  useDeliveryAttempts,
  useTimelineQuery,
  useTransfersQuery,
} from './queries';

/**
 * The pane the screen exists for.
 *
 * Everything on it was read back from the API: the status the backend applied, the transfers it
 * observed on chain, the callbacks it decided to send. The browser reports nothing, hints nothing
 * and confirms nothing, which is why a payment made from a phone on the other side of the room
 * lands here identically.
 */

function ConsoleLine({
  at,
  channel,
  children,
}: {
  at: string;
  channel: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-2 last:border-b-0">
      <time dateTime={at} className="tabular w-44 shrink-0 text-text-subtle">
        {formatTimestamp(at)}
      </time>
      <span className="w-20 shrink-0 tracking-wide text-text-subtle uppercase">{channel}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-text">
        {children}
      </span>
    </li>
  );
}

function AttemptDetail({ attempt }: { attempt: WebhookAttempt }) {
  return (
    <>
      <span className="tabular text-text-muted">attempt {attempt.attemptNumber.toString()}</span>
      <span className={outcomeTone(attempt.outcome)}>{attempt.outcome}</span>
      {attempt.responseStatus !== null && (
        <span className="tabular text-text-muted">HTTP {attempt.responseStatus.toString()}</span>
      )}
      <span className="tabular text-text-subtle">{attempt.durationMilliseconds.toString()} ms</span>
      {attempt.failureReason !== null && (
        <span className="text-status-canceled">{attempt.failureReason}</span>
      )}
      {attempt.usedPrivateAllowlist && (
        <span className="text-status-partially-funded">private allowlist</span>
      )}
    </>
  );
}

function ConsoleEntryLine({ entry }: { entry: ConsoleEntry }) {
  switch (entry.kind) {
    case 'created':
      return (
        <ConsoleLine at={entry.at} channel="payment">
          <span className="text-text-muted">created</span>
          <Copyable value={entry.payment.identifier} />
          <Amount
            display={entry.payment.requestedAmount.display}
            symbol={entry.payment.asset.symbol}
          />
          <span className="text-text-subtle">on {networkLabel(entry.payment.network)}</span>
        </ConsoleLine>
      );
    case 'status':
      return (
        <ConsoleLine at={entry.at} channel="status">
          {entry.change.fromStatus !== null && (
            <>
              <PaymentStatusView status={entry.change.fromStatus} />
              <span className="text-text-subtle">to</span>
            </>
          )}
          <PaymentStatusView status={entry.change.toStatus} />
          <span className="text-text-muted">{entry.change.trigger}</span>
          <span className="tabular text-text-subtle">
            version {entry.change.statusVersion.toString()}
          </span>
        </ConsoleLine>
      );
    case 'transfer':
      return (
        <ConsoleLine at={entry.at} channel="transfer">
          <Amount display={entry.transfer.amount.display} />
          <span className={classificationTone(entry.transfer.classification)}>
            {entry.transfer.classification}
          </span>
          <span className={observationTone(entry.transfer.observation)}>
            {entry.transfer.observation}
          </span>
          <span className="tabular text-text-subtle">block {entry.transfer.blockHeight}</span>
          <Copyable value={entry.transfer.transactionReference} />
        </ConsoleLine>
      );
    case 'callback':
      return (
        <ConsoleLine at={entry.at} channel="callback">
          <span className="text-text-muted">queued</span>
          <span className="font-medium">{entry.delivery.eventType}</span>
          <span className="text-text-subtle">{entry.delivery.destinationUrl}</span>
          <Copyable value={entry.delivery.identifier} />
        </ConsoleLine>
      );
    case 'attempt':
      return (
        <ConsoleLine at={entry.at} channel="callback">
          <AttemptDetail attempt={entry.attempt} />
        </ConsoleLine>
      );
  }
}

interface ReadFailure {
  readonly source: string;
  readonly detail: string;
}

/**
 * A source that could not be read is named rather than rendered as an absence. An empty section on
 * this pane reads as "the backend concluded nothing", which is the opposite of what a failed read
 * means, and this is the screen whose whole purpose is telling those two apart.
 */
function ReadFailures({ failures }: { failures: readonly ReadFailure[] }) {
  if (failures.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-health-failed bg-health-failed-soft px-5 py-3 text-xs text-health-failed"
    >
      <p className="font-medium">
        The console below is incomplete. These sources could not be read, so lines they would have
        contributed are missing rather than absent.
      </p>
      <ul className="mt-1 space-y-0.5">
        {failures.map((failure) => (
          <li key={failure.source}>
            {failure.source}: {failure.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VerifyPane({
  identifier,
  payment,
  isFinal,
  isLoading,
  paymentError,
  updatedAt,
}: {
  identifier: string | null;
  payment: Payment | null;
  isFinal: boolean;
  isLoading: boolean;
  paymentError: Error | null;
  updatedAt: number;
}) {
  const timeline = useTimelineQuery(identifier, isFinal);
  const transfers = useTransfersQuery(identifier, isFinal);
  const deliveries = useDeliveriesQuery(identifier);
  const deliveryList = deliveries.data?.data ?? [];
  const details = useDeliveryAttempts(deliveryList);

  const attemptsByDelivery = new Map(
    details.map((detail) => [detail.identifier, detail.attempts] as const),
  );

  const readFailures = [
    { source: 'The payment', failure: paymentError },
    { source: 'The status timeline', failure: timeline.error },
    { source: 'The observed transfers', failure: transfers.error },
    { source: 'The callback deliveries', failure: deliveries.error },
  ].flatMap(({ source, failure }) =>
    failure === null ? [] : [{ source, detail: readErrorDetail(failure) }],
  );

  const entries = buildConsoleEntries({
    payment,
    timeline: timeline.data?.data ?? [],
    transfers: transfers.data?.data ?? [],
    deliveries: deliveryList,
    attemptsByDelivery,
  });

  const header = (
    <CardHeader
      title="3. Verify"
      description="Read back from the API. This pane only ever sends GET requests, so nothing on it was told to the backend by this browser."
      action={
        payment === null ? undefined : <PaymentStatusView status={payment.status} size="large" />
      }
    />
  );

  if (identifier === null) {
    return (
      <Card className="lg:col-span-2">
        {header}
        <EmptyState
          title="Nothing to verify yet"
          description="Create a payment in the first pane, then pay it from the second one with any wallet. Every conclusion the backend reaches about it appears here, in the order it reached them."
        />
      </Card>
    );
  }

  // Only when there is nothing to show. A background refetch that failed still leaves the record of
  // what the backend concluded, and replacing it with an error page destroys the evidence.
  if (payment === null && paymentError !== null) {
    return (
      <Card className="lg:col-span-2">
        {header}
        <ErrorState title="This payment could not be read" detail={readErrorDetail(paymentError)} />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="lg:col-span-2">
        {header}
        <SkeletonRows rows={6} />
      </Card>
    );
  }

  return (
    <Card className="lg:col-span-2">
      {header}
      <ReadFailures failures={readFailures} />
      {entries.length === 0 ? (
        <EmptyState
          title="No events recorded yet"
          description="The payment exists and the backend has concluded nothing about it beyond creating it. Send the amount to the receiving address and the first observed transfer will appear here on its own."
        />
      ) : (
        <div className="max-h-[32rem] overflow-auto">
          <ul className="min-w-max font-mono text-xs">
            {entries.map((entry) => (
              <ConsoleEntryLine key={entry.key} entry={entry} />
            ))}
          </ul>
        </div>
      )}
      <CardBody className="flex flex-wrap items-center justify-between gap-2 border-t border-border text-xs text-text-subtle">
        <span>
          {isFinal
            ? 'The payment reached a terminal status. Polling has stopped.'
            : 'Polling the payment, its timeline, its transfers and its deliveries.'}
        </span>
        {updatedAt > 0 && (
          <span className="tabular">
            Last read {formatTimestamp(new Date(updatedAt).toISOString())}
          </span>
        )}
      </CardBody>
    </Card>
  );
}
