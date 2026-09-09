'use client';

import type { NetworkDescriptor } from '@cryptopay/shared';
import { useQuery } from '@tanstack/react-query';

import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { NetworkCard } from './network-card';

/**
 * Every chain this key can be paid on, and whether each one is working.
 *
 * Polled rather than server rendered, because the only figures worth showing here change: a scan
 * position baked into the first paint is stale before it is read, and a halted network that looks
 * healthy because the page was rendered before it stopped is worse than no page at all.
 */

interface Collection<T> {
  readonly data: readonly T[];
}

const NETWORK_POLL_MILLISECONDS = 10_000;

export function NetworksScreen() {
  const networks = useQuery({
    queryKey: ['networks'],
    queryFn: ({ signal }) => callApi<Collection<NetworkDescriptor>>('v1/networks', { signal }),
    refetchInterval: NETWORK_POLL_MILLISECONDS,
  });

  if (networks.isPending) {
    return <SkeletonRows rows={3} />;
  }
  if (networks.isError) {
    return (
      <ErrorState
        title="The networks could not be read"
        detail={networks.error instanceof Error ? networks.error.message : 'Unknown error'}
      />
    );
  }

  const listed = networks.data.data;
  if (listed.length === 0) {
    return (
      <EmptyState
        title="No network is being watched"
        description="A network appears here once a scanner has reached it. Until then a payment created on it would never be detected, so none is offered."
      />
    );
  }

  return (
    <div className="space-y-4">
      {listed.map((network) => (
        <NetworkCard key={network.network} network={network} />
      ))}
    </div>
  );
}
