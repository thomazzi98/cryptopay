'use client';

import type { PaymentTransfer } from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Amount, Copyable } from '@/components/ui/data';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';
import { formatTimestamp, truncateReference } from '@/lib/format';

import { ExternalLink } from './external-link';
import { describeFailure, fetchTransfers, transfersQueryKey } from './queries';

/**
 * Every transfer ever seen at this address, orphaned ones included.
 *
 * An orphaned transfer is struck through and labelled rather than removed. A reorg withdrawing money
 * that a customer watched arrive is exactly the moment support gets called, and a list that quietly
 * drops the row leaves nobody able to explain where it went. The same applies to a transfer of the
 * wrong token: it is not this payment's money, and hiding it does not make the customer's money
 * reappear.
 */

interface ClassificationDescriptor {
  readonly label: string;
  readonly className: string;
  readonly help: string;
}

const CLASSIFICATIONS: Readonly<
  Record<PaymentTransfer['classification'], ClassificationDescriptor>
> = Object.freeze({
  credited: {
    label: 'Credited',
    className: 'border-status-completed bg-status-completed-soft text-status-completed',
    help: 'Counted towards the amount credited to this payment.',
  },
  late: {
    label: 'Late',
    className:
      'border-status-partially-funded bg-status-partially-funded-soft text-status-partially-funded',
    help: 'Arrived after the payment had already finished, so it was recorded but not applied.',
  },
  unexpected: {
    label: 'Unexpected',
    className: 'border-status-overpaid bg-status-overpaid-soft text-status-overpaid',
    help: 'Reached this address without belonging to what the payment expected.',
  },
  wrong_asset: {
    label: 'Wrong asset',
    className: 'border-status-canceled bg-status-canceled-soft text-status-canceled',
    help: 'A different token than the one this payment asked for. Token identity is the contract address, never the symbol.',
  },
});

const OBSERVATIONS: Readonly<Record<PaymentTransfer['observation'], string>> = Object.freeze({
  observed: 'Observed',
  finalized: 'Finalized',
  orphaned: 'Orphaned by a reorg',
});

const HEADER_CLASS =
  'px-4 py-2.5 text-left text-xs font-medium tracking-wide text-text-subtle uppercase';

export function TransfersPanel({
  paymentIdentifier,
  pollIntervalMilliseconds,
}: {
  paymentIdentifier: string;
  pollIntervalMilliseconds: number | false;
}) {
  const transfersQuery = useQuery({
    queryKey: transfersQueryKey(paymentIdentifier),
    queryFn: ({ signal }) => fetchTransfers(paymentIdentifier, signal),
    refetchInterval: pollIntervalMilliseconds,
  });

  const transfers = transfersQuery.data;

  // A failed refetch keeps the last good rows, so the failure replaces the table only when there is
  // no table to keep.
  if (transfers === undefined && transfersQuery.isError) {
    return (
      <ErrorState
        title="The transfers could not be loaded"
        detail={describeFailure(transfersQuery.error)}
        action={
          <Button
            onClick={() => {
              void transfersQuery.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (transfers === undefined) {
    return <SkeletonRows rows={3} />;
  }

  if (transfers.length === 0) {
    return (
      <EmptyState
        title="Nothing has arrived yet"
        description="No transfer has been seen at this address. Anything that arrives, including a wrong token or a late payment, is listed here."
      />
    );
  }

  const hasOrphan = transfers.some((transfer) => transfer.observation === 'orphaned');

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-3xl border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={HEADER_CLASS}>
                Transaction
              </th>
              <th scope="col" className={HEADER_CLASS}>
                From
              </th>
              <th scope="col" className={classNames(HEADER_CLASS, 'text-right')}>
                Amount
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Classification
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Chain state
              </th>
              <th scope="col" className={classNames(HEADER_CLASS, 'text-right')}>
                Block
              </th>
              <th scope="col" className={HEADER_CLASS}>
                Observed
              </th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((transfer) => {
              const classification = CLASSIFICATIONS[transfer.classification];
              const isOrphaned = transfer.observation === 'orphaned';
              const struck = isOrphaned ? 'line-through' : '';

              return (
                <tr
                  key={`${transfer.transactionReference}-${transfer.eventIndex}`}
                  className={classNames(
                    'border-b border-border last:border-b-0',
                    isOrphaned && 'text-text-subtle',
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {transfer.explorerUrl === null ? (
                        <span
                          title={transfer.transactionReference}
                          className={classNames('tabular font-mono text-xs', struck)}
                        >
                          {truncateReference(transfer.transactionReference)}
                        </span>
                      ) : (
                        <ExternalLink
                          href={transfer.explorerUrl}
                          title={transfer.transactionReference}
                          className={classNames('tabular font-mono text-xs', struck)}
                        >
                          {truncateReference(transfer.transactionReference)}
                        </ExternalLink>
                      )}
                      <Copyable value={transfer.transactionReference} display="" />
                    </div>
                    <span className="tabular mt-0.5 block text-xs text-text-subtle">
                      event {transfer.eventIndex}
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    {transfer.sourceAccount === null ? (
                      <span
                        title="A Solana transaction may debit several accounts, so the chain names no single sender."
                        className="text-xs text-text-subtle"
                      >
                        not named by the chain
                      </span>
                    ) : (
                      <Copyable value={transfer.sourceAccount} className={struck} />
                    )}
                  </td>

                  <td className={classNames('px-4 py-3 text-right', struck)}>
                    <Amount display={transfer.amount.display} emphasis="strong" />
                  </td>

                  <td className="px-4 py-3">
                    <span
                      title={classification.help}
                      className={classNames(
                        'inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                        classification.className,
                      )}
                    >
                      {classification.label}
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <span
                      className={classNames(
                        'text-xs whitespace-nowrap',
                        isOrphaned ? 'font-medium text-status-canceled' : 'text-text-muted',
                      )}
                    >
                      {OBSERVATIONS[transfer.observation]}
                    </span>
                  </td>

                  <td
                    className={classNames('tabular px-4 py-3 text-right text-xs', struck)}
                    title={transfer.blockReference}
                  >
                    {transfer.blockHeight}
                  </td>

                  <td className="tabular px-4 py-3 text-xs whitespace-nowrap">
                    {formatTimestamp(transfer.observedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasOrphan && (
        <p className="border-t border-border px-4 py-3 text-xs text-text-muted">
          A struck-through row was withdrawn by a chain reorganisation. It is kept here because the
          customer saw it arrive, and because the amount credited to this payment no longer includes
          it.
        </p>
      )}
    </div>
  );
}
