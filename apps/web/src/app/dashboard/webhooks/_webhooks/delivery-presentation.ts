import type { WebhookAttempt, WebhookDelivery } from '@cryptopay/shared';

/**
 * The vocabulary of a callback, described once.
 *
 * A delivery status is not a payment status, so it neither borrows StatusBadge nor the status
 * palette: those tokens are one per PaymentStatus and a delivery dressed in them would only look
 * right by coincidence. Delivery health uses the health tokens, and the word carries the meaning
 * either way — nothing here is legible by hue alone.
 */

export type DeliveryStatus = WebhookDelivery['status'];
export type AttemptOutcome = WebhookAttempt['outcome'];

interface Tone {
  readonly label: string;
  readonly summary: string;
  readonly className: string;
}

export const DELIVERY_STATUS_TONES: Readonly<Record<DeliveryStatus, Tone>> = Object.freeze({
  pending: {
    label: 'Queued',
    summary: 'Waiting for its next attempt. It will be sent without you doing anything.',
    className: 'border-border bg-surface-sunken text-text-muted',
  },
  in_flight: {
    label: 'Sending',
    summary: 'An attempt is running right now. A redelivery is refused until it finishes.',
    className: 'border-accent bg-accent-soft text-accent',
  },
  delivered: {
    label: 'Delivered',
    summary: 'Your endpoint answered with a success status.',
    className: 'border-health-ok bg-health-ok-soft text-health-ok',
  },
  failed: {
    label: 'Failed',
    summary: 'The last attempt did not succeed. Another one is scheduled.',
    className: 'border-health-degraded bg-health-degraded-soft text-health-degraded',
  },
  abandoned: {
    label: 'Abandoned',
    summary: 'Every scheduled attempt was used. Only a redelivery will send it again.',
    className: 'border-health-failed bg-health-failed-soft text-health-failed',
  },
});

export const ATTEMPT_OUTCOME_TONES: Readonly<Record<AttemptOutcome, Tone>> = Object.freeze({
  delivered: {
    label: 'Delivered',
    summary: 'The endpoint answered with a success status.',
    className: 'border-health-ok bg-health-ok-soft text-health-ok',
  },
  retryable: {
    label: 'Retryable',
    summary: 'A failure worth trying again, such as a 5xx or a refused connection.',
    className: 'border-health-degraded bg-health-degraded-soft text-health-degraded',
  },
  permanent: {
    label: 'Permanent',
    summary: 'The endpoint rejected the request in a way that retrying cannot fix.',
    className: 'border-health-failed bg-health-failed-soft text-health-failed',
  },
  blocked: {
    label: 'Blocked',
    summary: 'The callback policy refused the request before it left the network.',
    className: 'border-health-failed bg-health-failed-soft text-health-failed',
  },
  timeout: {
    label: 'Timed out',
    summary: 'The endpoint accepted the connection but did not answer in time.',
    className: 'border-health-degraded bg-health-degraded-soft text-health-degraded',
  },
});

/** Live states first: those are the ones with something still to happen. */
export const DELIVERY_STATUS_ORDER: readonly DeliveryStatus[] = Object.freeze([
  'pending',
  'in_flight',
  'failed',
  'abandoned',
  'delivered',
]);

const STILL_MOVING = new Set<DeliveryStatus>(['pending', 'failed', 'in_flight']);

/** A retry lands on its own, so the list has to keep asking while anything is still moving. */
export function isAwaitingRetry(status: DeliveryStatus): boolean {
  return STILL_MOVING.has(status);
}
