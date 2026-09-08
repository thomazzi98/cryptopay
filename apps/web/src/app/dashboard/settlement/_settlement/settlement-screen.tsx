'use client';

import type {
  NetworkDescriptor,
  PayoutDestination,
  Settlement,
  TreasuryReport,
} from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';

import { Card, CardHeader, EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { PayoutDestinations } from './payout-destinations';
import { SettlementTable } from './settlement-table';
import { TreasuryCard } from './treasury-card';

/**
 * Where the money is after a payment completes.
 *
 * The dashboard could show every payment as complete and still leave an operator with no idea
 * whether the funds had moved, which for a payment product is the question that actually matters.
 * This screen answers it in the order it fails: is settlement even switched on, is there gas, is
 * there somewhere to send to, and then what happened to each one.
 */

interface Collection<T> {
  readonly data: readonly T[];
}

const SETTLEMENT_POLL_MILLISECONDS = 8000;

function isMoving(settlements: readonly Settlement[]): boolean {
  return settlements.some(
    (settlement) => settlement.status !== 'settled' && settlement.status !== 'failed',
  );
}

export function SettlementScreen() {
  const treasury = useQuery({
    queryKey: ['treasury'],
    queryFn: ({ signal }) => callApi<Collection<TreasuryReport>>('v1/treasury', { signal }),
    refetchInterval: SETTLEMENT_POLL_MILLISECONDS,
  });

  const settlements = useQuery({
    queryKey: ['settlements'],
    queryFn: ({ signal }) => callApi<Collection<Settlement>>('v1/settlements', { signal }),
    // Stops polling once nothing is in flight, so an idle dashboard is not a source of load.
    refetchInterval: (query) =>
      isMoving(query.state.data?.data ?? []) ? SETTLEMENT_POLL_MILLISECONDS : false,
  });

  const networks = useQuery({
    queryKey: ['networks'],
    queryFn: ({ signal }) => callApi<Collection<NetworkDescriptor>>('v1/networks', { signal }),
  });

  const destinations = useQuery({
    queryKey: ['payout-destinations'],
    queryFn: ({ signal }) =>
      callApi<Collection<PayoutDestination>>('v1/payout-destinations', { signal }),
  });

  return (
    <div className="space-y-6">
      {treasury.error !== null && (
        <ErrorState
          title="The treasury could not be read"
          detail={treasury.error instanceof Error ? treasury.error.message : 'Unknown failure.'}
        />
      )}

      {treasury.error === null && treasury.isPending && (
        <Card>
          <CardHeader title="Treasury" description="Reading what this deployment can spend." />
          <SkeletonRows rows={3} className="px-5 pb-5" />
        </Card>
      )}

      {treasury.error === null && treasury.data !== undefined && (
        <div className="grid gap-6 lg:grid-cols-2">
          {treasury.data.data.length === 0 ? (
            <Card>
              <CardHeader title="Treasury" description="Nothing has reported a treasury yet." />
              <EmptyState
                title="No settlement worker has started"
                description="The treasury address is derived by the process that signs, which is the only one holding key material. Until it runs there is no address to fund and nothing to report."
              />
            </Card>
          ) : (
            treasury.data.data.map((report) => (
              <TreasuryCard key={report.network} report={report} />
            ))
          )}

          {destinations.data !== undefined && networks.data !== undefined && (
            <PayoutDestinations
              networks={networks.data.data}
              destinations={destinations.data.data}
            />
          )}
        </div>
      )}

      <Card>
        <CardHeader
          title="Settlements"
          description="One per payment, with every transaction it took to move the money."
        />

        {settlements.error !== null && (
          <ErrorState
            title="Settlements could not be read"
            detail={
              settlements.error instanceof Error ? settlements.error.message : 'Unknown failure.'
            }
          />
        )}

        {settlements.error === null && settlements.isPending && (
          <SkeletonRows rows={4} className="px-5 pb-5" />
        )}

        {settlements.error === null &&
          settlements.data !== undefined &&
          (settlements.data.data.length === 0 ? (
            <EmptyState
              title="Nothing has been settled yet"
              description="A settlement is planned once a payment finishes and its deposit address holds a balance. An address holding nothing costs one balance read and no transaction."
            />
          ) : (
            <div className="px-5 pb-5">
              <SettlementTable settlements={settlements.data.data} />
            </div>
          ))}
      </Card>
    </div>
  );
}
