import type {
  Payment,
  PaymentStatusChange,
  PaymentTransfer,
  WebhookAttempt,
} from '@cryptopay/shared';

import type { PaymentDelivery } from './queries';

/**
 * The console is assembled from four independent reads and merged on time, not on arrival.
 *
 * Each line therefore states when the backend decided something, never when the browser found out.
 * A transfer observed while the tab was closed appears in its true place in the sequence, which is
 * the only way the ordering can be used as evidence of anything.
 */

interface EntryBase {
  readonly key: string;
  readonly at: string;
}

export type ConsoleEntry =
  | (EntryBase & { readonly kind: 'created'; readonly payment: Payment })
  | (EntryBase & { readonly kind: 'status'; readonly change: PaymentStatusChange })
  | (EntryBase & { readonly kind: 'transfer'; readonly transfer: PaymentTransfer })
  | (EntryBase & { readonly kind: 'callback'; readonly delivery: PaymentDelivery })
  | (EntryBase & {
      readonly kind: 'attempt';
      readonly delivery: PaymentDelivery;
      readonly attempt: WebhookAttempt;
    });

interface ConsoleSources {
  readonly payment: Payment | null;
  readonly timeline: readonly PaymentStatusChange[];
  readonly transfers: readonly PaymentTransfer[];
  readonly deliveries: readonly PaymentDelivery[];
  readonly attemptsByDelivery: ReadonlyMap<string, readonly WebhookAttempt[]>;
}

/** Ties are broken by cause before effect: a status change precedes the callback it produced. */
const KIND_RANK: Readonly<Record<ConsoleEntry['kind'], number>> = Object.freeze({
  created: 0,
  transfer: 1,
  status: 2,
  callback: 3,
  attempt: 4,
});

export function buildConsoleEntries(sources: ConsoleSources): ConsoleEntry[] {
  const payment = sources.payment;
  if (payment === null) {
    return [];
  }

  const entries: ConsoleEntry[] = [
    { kind: 'created', key: 'created', at: payment.createdAt, payment },
  ];

  for (const change of sources.timeline) {
    entries.push({
      kind: 'status',
      key: `status:${change.statusVersion.toString()}`,
      at: change.occurredAt,
      change,
    });
  }

  for (const transfer of sources.transfers) {
    entries.push({
      kind: 'transfer',
      key: `transfer:${transfer.transactionReference}:${transfer.eventIndex.toString()}:${transfer.observation}`,
      at: transfer.observedAt,
      transfer,
    });
  }

  for (const delivery of sources.deliveries) {
    entries.push({
      kind: 'callback',
      key: `delivery:${delivery.identifier}`,
      at: delivery.createdAt,
      delivery,
    });

    const attempts = sources.attemptsByDelivery.get(delivery.identifier) ?? [];
    for (const attempt of attempts) {
      entries.push({
        kind: 'attempt',
        key: `attempt:${delivery.identifier}:${attempt.attemptNumber.toString()}`,
        at: attempt.requestedAt,
        delivery,
        attempt,
      });
    }
  }

  return entries.toSorted((first, second) => {
    const difference = Date.parse(first.at) - Date.parse(second.at);
    if (difference !== 0) {
      return difference;
    }
    return KIND_RANK[first.kind] - KIND_RANK[second.kind];
  });
}
