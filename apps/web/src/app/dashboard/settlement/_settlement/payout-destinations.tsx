'use client';

import type { NetworkDescriptor, PayoutDestination } from '@cryptopay/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { callApi } from '@/lib/api-client';

import { errorDetail } from '@/app/dashboard/webhooks/_webhooks/error-detail';

/**
 * Where settled funds are sent, set per network.
 *
 * Per network rather than once, and that is not a formality. An address a merchant controls on one
 * chain is not necessarily theirs on another — a contract wallet at the same address may not exist
 * there, or may belong to somebody else — so defaulting one network's destination from another is a
 * way to send funds to an account nobody can open.
 *
 * A network with no destination configured is never swept. Funds stay in the deposit address, which
 * is safe and completely useless, so the absence is stated rather than left to be noticed.
 */

export function PayoutDestinations({
  networks,
  destinations,
}: {
  networks: readonly NetworkDescriptor[];
  destinations: readonly PayoutDestination[];
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ network, account }: { network: string; account: string }) =>
      callApi<PayoutDestination>(`v1/payout-destinations/${network}`, {
        method: 'PUT',
        body: { account },
      }),
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: ['payout-destinations'] });
    },
    onError: (error: unknown) => {
      setFailure(errorDetail(error));
    },
  });

  const byNetwork = new Map(destinations.map((entry) => [entry.network, entry]));

  function submit(event: FormEvent<HTMLFormElement>, network: string): void {
    event.preventDefault();
    const account = (drafts[network] ?? '').trim().toLowerCase();
    if (account === '') {
      return;
    }
    save.mutate({ network, account });
  }

  return (
    <Card>
      <CardHeader
        title="Payout destinations"
        description="Where swept funds are sent, per network. A network with none is never swept."
      />
      <CardBody className="space-y-5">
        {networks.length === 0 && (
          <p className="text-sm text-text-muted">
            No network is available to this key, so there is nothing to configure yet.
          </p>
        )}

        {networks.map((network) => {
          const existing = byNetwork.get(network.network);
          return (
            <form
              key={network.network}
              onSubmit={(event) => {
                submit(event, network.network);
              }}
              className="space-y-2 border-b border-border pb-4 last:border-b-0 last:pb-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <label
                  htmlFor={`payout-${network.network}`}
                  className="text-sm font-medium text-text"
                >
                  {network.displayName}
                </label>
                {existing === undefined ? (
                  <span className="text-xs text-status-underpaid">Not configured</span>
                ) : (
                  <span className="text-xs text-text-muted">Set</span>
                )}
              </div>

              {existing !== undefined && (
                <div className="text-xs">
                  <Copyable value={existing.account} />
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <input
                  id={`payout-${network.network}`}
                  className="tabular min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle"
                  placeholder={existing?.account ?? '0x…'}
                  value={drafts[network.network] ?? ''}
                  onChange={(event) => {
                    setDrafts({ ...drafts, [network.network]: event.target.value });
                  }}
                  spellCheck={false}
                />
                <Button
                  type="submit"
                  size="small"
                  loading={save.isPending && save.variables.network === network.network}
                  disabled={(drafts[network.network] ?? '').trim() === ''}
                >
                  {existing === undefined ? 'Set' : 'Replace'}
                </Button>
              </div>

              {existing === undefined && (
                <p className="text-xs text-text-muted">
                  Until this is set, money from finished payments on {network.displayName} stays at
                  the address the customer paid into.
                </p>
              )}
            </form>
          );
        })}

        {failure !== null && (
          <p role="alert" className="text-sm text-status-underpaid">
            {failure}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
