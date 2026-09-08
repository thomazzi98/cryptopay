import { isNetworkIdentifier, isPaymentStatus, type NetworkIdentifier } from '@cryptopay/shared';

import { ApiError } from '@/lib/api-client';
import { StatusBadge } from '@/components/ui/status-badge';

/**
 * The small vocabulary this screen needs on top of the shared components: a readable network name,
 * a tone for the two chain-side classifications, and a status that stays a badge even when the API
 * reports one this build has never heard of.
 */

const NETWORK_LABELS: Readonly<Record<NetworkIdentifier, string>> = Object.freeze({
  'polygon-mainnet': 'Polygon mainnet',
  'polygon-amoy': 'Polygon Amoy',
  'local-anvil': 'Local Anvil',
});

export function networkLabel(value: string): string {
  if (isNetworkIdentifier(value)) {
    return NETWORK_LABELS[value];
  }
  return value;
}

const NEUTRAL_TONE = 'text-text-muted';

const CLASSIFICATION_TONES: Readonly<Record<string, string>> = Object.freeze({
  credited: 'text-status-completed',
  late: 'text-status-partially-funded',
  unexpected: 'text-status-overpaid',
  wrong_asset: 'text-status-canceled',
});

const OBSERVATION_TONES: Readonly<Record<string, string>> = Object.freeze({
  observed: 'text-status-confirming',
  finalized: 'text-status-completed',
  orphaned: 'text-status-canceled',
});

const OUTCOME_TONES: Readonly<Record<string, string>> = Object.freeze({
  delivered: 'text-status-completed',
  retryable: 'text-status-partially-funded',
  permanent: 'text-status-canceled',
  blocked: 'text-status-canceled',
  timeout: 'text-status-underpaid',
});

export function classificationTone(value: string): string {
  return CLASSIFICATION_TONES[value] ?? NEUTRAL_TONE;
}

export function observationTone(value: string): string {
  return OBSERVATION_TONES[value] ?? NEUTRAL_TONE;
}

export function outcomeTone(value: string): string {
  return OUTCOME_TONES[value] ?? NEUTRAL_TONE;
}

/**
 * The wire type for a status is a string, so a status the API knows and this build does not is
 * expressible. It is shown as itself rather than dropped: a line missing from an audit console is
 * worse than one that renders plainly.
 */
export function PaymentStatusView({
  status,
  size,
}: {
  status: string;
  size?: 'default' | 'large';
}) {
  if (isPaymentStatus(status)) {
    return <StatusBadge status={status} {...(size !== undefined && { size })} />;
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border-strong bg-surface-sunken px-2 py-0.5 text-xs font-medium text-text-muted">
      {status}
    </span>
  );
}

/** What the API actually said, never replaced with a generic message. */
export function readErrorDetail(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request did not reach the API.';
}
