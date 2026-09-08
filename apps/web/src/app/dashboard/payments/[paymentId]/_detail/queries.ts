import type {
  Payment,
  PaymentStatus,
  PaymentStatusChange,
  PaymentTransfer,
  WebhookDelivery,
} from '@cryptopay/shared';
import { isPaymentStatus } from '@cryptopay/shared';

import { ApiError, callApi } from '@/lib/api-client';

/**
 * Every read this screen makes, and the two conversions it needs.
 *
 * A payment's own delivery endpoint answers a summary rather than a whole WebhookDelivery: there is
 * no attempt list and no next-attempt time on it. Deriving the type with Pick states that difference
 * instead of widening it, so a panel cannot render a field the endpoint never sends.
 *
 * The contract types a status as a plain string, because the schema is built from a runtime list.
 * It is narrowed once, here, rather than asserted at each of the six places that need a colour.
 */

export type PaymentDeliverySummary = Pick<
  WebhookDelivery,
  | 'identifier'
  | 'eventType'
  | 'destinationUrl'
  | 'status'
  | 'attemptCount'
  | 'deliveredAt'
  | 'lastFailure'
  | 'createdAt'
>;

interface Collection<T> {
  readonly data: readonly T[];
}

export function paymentQueryKey(identifier: string): readonly string[] {
  return ['payment', identifier];
}

export function timelineQueryKey(identifier: string): readonly string[] {
  return ['payment', identifier, 'timeline'];
}

export function transfersQueryKey(identifier: string): readonly string[] {
  return ['payment', identifier, 'transfers'];
}

export function deliveriesQueryKey(identifier: string): readonly string[] {
  return ['payment', identifier, 'deliveries'];
}

export function fetchPayment(identifier: string, signal: AbortSignal): Promise<Payment> {
  return callApi<Payment>(`v1/payments/${identifier}`, { signal });
}

export async function fetchTimeline(
  identifier: string,
  signal: AbortSignal,
): Promise<readonly PaymentStatusChange[]> {
  const collection = await callApi<Collection<PaymentStatusChange>>(
    `v1/payments/${identifier}/timeline`,
    { signal },
  );
  return collection.data;
}

export async function fetchTransfers(
  identifier: string,
  signal: AbortSignal,
): Promise<readonly PaymentTransfer[]> {
  const collection = await callApi<Collection<PaymentTransfer>>(
    `v1/payments/${identifier}/transfers`,
    { signal },
  );
  return collection.data;
}

export async function fetchDeliveries(
  identifier: string,
  signal: AbortSignal,
): Promise<readonly PaymentDeliverySummary[]> {
  const collection = await callApi<Collection<PaymentDeliverySummary>>(
    `v1/payments/${identifier}/deliveries`,
    { signal },
  );
  return collection.data;
}

export function cancelPayment(identifier: string): Promise<Payment> {
  return callApi<Payment>(`v1/payments/${identifier}/cancel`, { method: 'POST' });
}

export function redeliverWebhook(deliveryIdentifier: string): Promise<unknown> {
  return callApi<unknown>(`v1/webhooks/deliveries/${deliveryIdentifier}/redeliver`, {
    method: 'POST',
  });
}

export function readPaymentStatus(value: string): PaymentStatus | null {
  return isPaymentStatus(value) ? value : null;
}

/**
 * What the API actually said, never a generic message. A refusal to cancel names the current status
 * and the reason, and that sentence is the entire value of the response.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The dashboard could not reach the API.';
}
