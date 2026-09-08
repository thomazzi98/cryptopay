'use client';

import type {
  Merchant,
  Payment,
  PaymentStatusChange,
  PaymentTransfer,
  WebhookDelivery,
} from '@cryptopay/shared';
import { isPaymentStatus, isTerminalPaymentStatus } from '@cryptopay/shared';
import { useQueries, useQuery } from '@tanstack/react-query';

import { callApi } from '@/lib/api-client';

/**
 * Every request this module makes is a GET. That is the claim the verify pane makes in its copy, so
 * it is kept true here rather than in a comment on the pane: nothing below writes, and the single
 * write in this screen lives in the create pane where a merchant can watch it happen.
 */

const LIVE_POLL_MILLISECONDS = 3000;
const DELIVERY_POLL_MILLISECONDS = 4000;

/** What `/v1/payments/{id}/deliveries` returns: a delivery without its attempt history. */
export type PaymentDelivery = Omit<
  WebhookDelivery,
  'attempts' | 'nextAttemptAt' | 'paymentIdentifier'
>;

interface Collection<T> {
  readonly data: T[];
}

function isSettledPayment(payment: Payment | undefined): boolean {
  if (payment === undefined) {
    return false;
  }
  return isPaymentStatus(payment.status) && isTerminalPaymentStatus(payment.status);
}

function isSettledDelivery(status: string): boolean {
  return status === 'delivered' || status === 'abandoned';
}

/** Shares the settings screen's key, so the environment is read once per session. */
export function useMerchantQuery() {
  return useQuery({
    queryKey: ['merchant', 'me'],
    queryFn: ({ signal }) => callApi<Merchant>('v1/merchants/me', { signal }),
  });
}

export function usePaymentQuery(identifier: string | null) {
  return useQuery({
    queryKey: ['simulator', 'payment', identifier],
    queryFn: ({ signal }) => callApi<Payment>(`v1/payments/${identifier ?? ''}`, { signal }),
    enabled: identifier !== null,
    refetchInterval: (query) =>
      isSettledPayment(query.state.data) ? false : LIVE_POLL_MILLISECONDS,
  });
}

export function useTimelineQuery(identifier: string | null, isFinal: boolean) {
  return useQuery({
    queryKey: ['simulator', 'timeline', identifier],
    queryFn: ({ signal }) =>
      callApi<Collection<PaymentStatusChange>>(`v1/payments/${identifier ?? ''}/timeline`, {
        signal,
      }),
    enabled: identifier !== null,
    refetchInterval: isFinal ? false : LIVE_POLL_MILLISECONDS,
  });
}

export function useTransfersQuery(identifier: string | null, isFinal: boolean) {
  return useQuery({
    queryKey: ['simulator', 'transfers', identifier],
    queryFn: ({ signal }) =>
      callApi<Collection<PaymentTransfer>>(`v1/payments/${identifier ?? ''}/transfers`, { signal }),
    enabled: identifier !== null,
    refetchInterval: isFinal ? false : LIVE_POLL_MILLISECONDS,
  });
}

/**
 * Deliveries keep being polled after the payment settles: the last callback of a payment is retried
 * long after the payment itself stops moving, and a console that stopped there would leave a
 * delivery showing its first failed attempt for ever.
 */
export function useDeliveriesQuery(identifier: string | null) {
  return useQuery({
    queryKey: ['simulator', 'deliveries', identifier],
    queryFn: ({ signal }) =>
      callApi<Collection<PaymentDelivery>>(`v1/payments/${identifier ?? ''}/deliveries`, {
        signal,
      }),
    enabled: identifier !== null,
    refetchInterval: DELIVERY_POLL_MILLISECONDS,
  });
}

/**
 * The attempt history, which the payment-scoped list does not carry. One request per delivery is
 * the honest cost of showing what each attempt actually did rather than how many there were.
 */
export function useDeliveryAttempts(deliveries: readonly PaymentDelivery[]): WebhookDelivery[] {
  const results = useQueries({
    queries: deliveries.map((delivery) => ({
      queryKey: ['simulator', 'delivery', delivery.identifier],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        callApi<WebhookDelivery>(`v1/webhooks/deliveries/${delivery.identifier}`, { signal }),
      refetchInterval: isSettledDelivery(delivery.status) ? false : DELIVERY_POLL_MILLISECONDS,
    })),
  });

  return results.flatMap((result) => (result.data === undefined ? [] : [result.data]));
}
