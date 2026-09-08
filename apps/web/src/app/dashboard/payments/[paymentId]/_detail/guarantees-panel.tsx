'use client';

import type { Payment } from '@cryptopay/shared';

import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';

/**
 * Two guarantees, side by side and never merged into one number.
 *
 * The meter counts blocks mined on top of the transfer. The pip reports whether the chain itself
 * calls that block finalized. They move independently, and the state that costs money is the one
 * where the meter is full and the pip is not lit: a merchant who reads the meter alone ships goods
 * against a block a reorg can still take back. So the two are drawn differently, labelled
 * separately, and the disagreement between them is spelled out underneath rather than implied.
 */

const SEGMENTED_METER_LIMIT = 24;

function percentageOf(part: number, whole: number): number {
  // A ratio driving a bar width, not a monetary value. Nothing here is ever an amount.
  return Math.min(100, Math.round((part / whole) * 100));
}

function ConfirmationMeter({
  confirmations,
  requiredConfirmations,
}: {
  confirmations: number;
  requiredConfirmations: number;
}) {
  if (requiredConfirmations === 0) {
    return (
      <p className="text-sm text-text-muted">
        This network requires no confirmations, so the meter has nothing to count.
      </p>
    );
  }

  const reached = Math.min(confirmations, requiredConfirmations);
  const isComplete = confirmations >= requiredConfirmations;
  const filledClassName = isComplete ? 'bg-status-completed' : 'bg-status-confirming';

  return (
    <div
      role="progressbar"
      aria-label="Confirmations"
      aria-valuemin={0}
      aria-valuemax={requiredConfirmations}
      aria-valuenow={reached}
      aria-valuetext={`${confirmations} of ${requiredConfirmations} confirmations`}
    >
      {requiredConfirmations <= SEGMENTED_METER_LIMIT ? (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: requiredConfirmations }, (unused, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={classNames(
                'h-2.5 w-5 rounded-full',
                index < reached ? filledClassName : 'bg-surface-sunken ring-1 ring-border',
              )}
            />
          ))}
        </div>
      ) : (
        <div
          aria-hidden="true"
          className="h-2.5 w-full rounded-full bg-surface-sunken ring-1 ring-border"
        >
          <div
            className={classNames('h-full rounded-full', filledClassName)}
            style={{ width: `${percentageOf(reached, requiredConfirmations)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function FinalityPip({ finalityConfirmed }: { finalityConfirmed: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className={classNames(
          'size-3.5 rounded-full border-2',
          finalityConfirmed
            ? 'border-status-completed bg-status-completed'
            : 'border-border-strong bg-transparent',
        )}
      />
      <span
        className={classNames(
          'text-sm font-semibold',
          finalityConfirmed ? 'text-status-completed' : 'text-text-muted',
        )}
      >
        {finalityConfirmed ? 'Final' : 'Not final'}
      </span>
    </div>
  );
}

export function GuaranteesPanel({ payment }: { payment: Payment }) {
  const confirmationsComplete =
    payment.requiredConfirmations > 0 && payment.confirmations >= payment.requiredConfirmations;
  const disagrees = confirmationsComplete && !payment.finalityConfirmed;

  return (
    <Card>
      <CardHeader
        title="Settlement guarantees"
        description="Confirmations and finality are separate promises. A payment can hold every confirmation and still not be final."
      />
      <CardBody className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_16rem] sm:gap-8">
        <section aria-labelledby="confirmations-heading">
          <div className="flex items-baseline justify-between gap-4">
            <h3
              id="confirmations-heading"
              className="text-xs font-medium tracking-wide text-text-subtle uppercase"
            >
              Confirmations
            </h3>
            <p className="tabular text-sm font-semibold text-text">
              {payment.confirmations} / {payment.requiredConfirmations}
            </p>
          </div>
          <div className="mt-3">
            <ConfirmationMeter
              confirmations={payment.confirmations}
              requiredConfirmations={payment.requiredConfirmations}
            />
          </div>
          <p className="mt-2 text-xs text-text-muted">
            Blocks mined on top of the block that carried the transfer.
          </p>
        </section>

        <section
          aria-labelledby="finality-heading"
          className="border-t border-border pt-5 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8"
        >
          <h3
            id="finality-heading"
            className="text-xs font-medium tracking-wide text-text-subtle uppercase"
          >
            Finality
          </h3>
          <div className="mt-3">
            <FinalityPip finalityConfirmed={payment.finalityConfirmed} />
          </div>
          <p className="mt-2 text-xs text-text-muted">
            {payment.finalityConfirmed
              ? 'The settling block is covered by the finalized tag. No reorg can withdraw it.'
              : 'The settling block is not yet covered by the finalized tag. A reorg could still withdraw it.'}
          </p>
          <p className="tabular mt-2 text-xs text-text-subtle">
            {payment.settlingBlockHeight === null
              ? 'No settling block yet.'
              : `Settling block ${payment.settlingBlockHeight}`}
          </p>
        </section>
      </CardBody>

      {disagrees && (
        <p className="border-t border-border bg-status-partially-funded-soft px-5 py-3 text-sm text-status-partially-funded">
          Every required confirmation is in, but the chain has not finalized the block. This payment
          is not safe to fulfil yet.
        </p>
      )}
    </Card>
  );
}
