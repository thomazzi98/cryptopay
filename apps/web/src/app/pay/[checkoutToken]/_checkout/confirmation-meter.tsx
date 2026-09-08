import type { PaymentStatus } from '@cryptopay/shared';

import { describeStatus } from '@/lib/payment-status';

/**
 * How far the chain has gone towards making the money final.
 *
 * Below the segment limit each confirmation is drawn as its own block, because a customer watching
 * blocks land wants to see one arrive rather than watch a bar creep. Above it the segments would be
 * hairlines, so the same figure is drawn as a single bar instead.
 *
 * The confirmation count and the finality flag are reported separately on purpose: a count is a
 * heuristic and a finality tag is the chain's own answer, and conflating them is what lets a payment
 * look settled while it is still reorganisable.
 */

const MAXIMUM_SEGMENTS = 24;

export function ConfirmationMeter({
  status,
  confirmations,
  requiredConfirmations,
  finalityConfirmed,
}: {
  status: PaymentStatus;
  confirmations: number;
  requiredConfirmations: number;
  finalityConfirmed: boolean;
}) {
  const descriptor = describeStatus(status);
  const seen = Math.min(confirmations, requiredConfirmations);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          Confirmations
        </p>
        <p className="tabular text-sm text-text">
          {confirmations} / {requiredConfirmations}
        </p>
      </div>

      {requiredConfirmations === 0 && (
        <p className="mt-2 text-sm text-text-muted">
          This network needs no confirmation count. Finality alone decides.
        </p>
      )}

      {requiredConfirmations > 0 && requiredConfirmations <= MAXIMUM_SEGMENTS && (
        <div
          className="mt-2 flex gap-1"
          role="meter"
          aria-valuenow={seen}
          aria-valuemin={0}
          aria-valuemax={requiredConfirmations}
          aria-label="Confirmations received"
        >
          {Array.from({ length: requiredConfirmations }, (unused, index) => (
            <span
              key={index}
              className="h-2 flex-1 rounded-full bg-surface-sunken"
              style={index < seen ? { backgroundColor: descriptor.token } : undefined}
            />
          ))}
        </div>
      )}

      {requiredConfirmations > MAXIMUM_SEGMENTS && (
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
          role="meter"
          aria-valuenow={seen}
          aria-valuemin={0}
          aria-valuemax={requiredConfirmations}
          aria-label="Confirmations received"
        >
          <span
            className="block h-full rounded-full"
            style={{
              width: `${((seen / requiredConfirmations) * 100).toFixed(1)}%`,
              backgroundColor: descriptor.token,
            }}
          />
        </div>
      )}

      <p className="mt-2 text-xs text-text-muted">
        {finalityConfirmed
          ? 'The settling block is covered by the chain finality tag.'
          : 'The settling block is not yet covered by the chain finality tag.'}
      </p>
    </div>
  );
}
