import type { WebhookAttempt, WebhookDelivery } from '@cryptopay/shared';

/**
 * The vocabulary of a callback, described once.
 *
 * A delivery status is not a payment status, so it cannot borrow StatusBadge, but it borrows the
 * rule that badge follows: the word carries the meaning and the colour only reinforces it. Nothing
 * here is legible by hue alone.
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
    className: 'border-status-pending bg-status-pending-soft text-status-pending',
  },
  in_flight: {
    label: 'Sending',
    summary: 'An attempt is running right now. A redelivery is refused until it finishes.',
    className: 'border-status-confirming bg-status-confirming-soft text-status-confirming',
  },
  delivered: {
    label: 'Delivered',
    summary: 'Your endpoint answered with a success status.',
    className: 'border-status-completed bg-status-completed-soft text-status-completed',
  },
  failed: {
    label: 'Failed',
    summary: 'The last attempt did not succeed. Another one is scheduled.',
    className: 'border-status-underpaid bg-status-underpaid-soft text-status-underpaid',
  },
  abandoned: {
    label: 'Abandoned',
    summary: 'Every scheduled attempt was used. Only a redelivery will send it again.',
    className: 'border-status-canceled bg-status-canceled-soft text-status-canceled',
  },
});

export const ATTEMPT_OUTCOME_TONES: Readonly<Record<AttemptOutcome, Tone>> = Object.freeze({
  delivered: {
    label: 'Delivered',
    summary: 'The endpoint answered with a success status.',
    className: 'border-status-completed bg-status-completed-soft text-status-completed',
  },
  retryable: {
    label: 'Retryable',
    summary: 'A failure worth trying again, such as a 5xx or a refused connection.',
    className: 'border-status-underpaid bg-status-underpaid-soft text-status-underpaid',
  },
  permanent: {
    label: 'Permanent',
    summary: 'The endpoint rejected the request in a way that retrying cannot fix.',
    className: 'border-status-canceled bg-status-canceled-soft text-status-canceled',
  },
  blocked: {
    label: 'Blocked',
    summary: 'The callback policy refused the request before it left the network.',
    className: 'border-status-canceled bg-status-canceled-soft text-status-canceled',
  },
  timeout: {
    label: 'Timed out',
    summary: 'The endpoint accepted the connection but did not answer in time.',
    className: 'border-status-expired bg-status-expired-soft text-status-expired',
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
