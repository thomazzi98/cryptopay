import { classNames } from '@/lib/class-names';

import {
  ATTEMPT_OUTCOME_TONES,
  DELIVERY_STATUS_TONES,
  type AttemptOutcome,
  type DeliveryStatus,
} from './delivery-presentation';

const PILL =
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function DeliveryStatusBadge({
  status,
  className,
}: {
  status: DeliveryStatus;
  className?: string;
}) {
  const tone = DELIVERY_STATUS_TONES[status];
  return (
    <span className={classNames(PILL, tone.className, className)} title={tone.summary}>
      {tone.label}
    </span>
  );
}

export function AttemptOutcomeBadge({ outcome }: { outcome: AttemptOutcome }) {
  const tone = ATTEMPT_OUTCOME_TONES[outcome];
  return (
    <span className={classNames(PILL, tone.className)} title={tone.summary}>
      {tone.label}
    </span>
  );
}

/**
 * A development allowlist entry is what let this request reach a host the callback policy would
 * otherwise refuse. Nobody should find that out by accident, so it is stated on the attempt itself
 * rather than left to be inferred from an address that looks private.
 */
export function AllowlistNotice() {
  return (
    <p className="rounded-lg border border-status-underpaid bg-status-underpaid-soft px-3 py-2 text-xs text-status-underpaid">
      A development allowlist permitted this attempt. The callback policy would have refused this
      destination otherwise, so treat this attempt as a local test, not as proof the endpoint is
      reachable from production.
    </p>
  );
}
