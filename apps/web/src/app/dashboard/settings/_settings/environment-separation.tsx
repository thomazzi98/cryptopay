import type { Merchant } from '@cryptopay/shared';

import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';

/**
 * The claim a merchant most needs to trust, so it is stated as the mechanism rather than as a
 * reassurance. The environment of a payment and the network it settles on are checked against each
 * other by a table constraint, which means an application bug cannot turn a test key into a mainnet
 * row: the insert is refused by the database before any code gets a say.
 */

const NETWORKS_BY_ENVIRONMENT: Readonly<Record<Merchant['environment'], readonly string[]>> = {
  live: ['polygon-mainnet'],
  test: ['polygon-amoy', 'local-anvil'],
};

const CONSTRAINT_SOURCE = `CONSTRAINT payments_environment_network_consistent CHECK (
  (environment = 'live' AND network_identifier = 'polygon-mainnet')
  OR (environment = 'test' AND network_identifier IN ('polygon-amoy', 'local-anvil'))
)`;

export function EnvironmentSeparation({ environment }: { environment: Merchant['environment'] }) {
  const allowed = NETWORKS_BY_ENVIRONMENT[environment];

  return (
    <Card>
      <CardHeader
        title="Environment separation"
        description="Why a test key cannot reach mainnet, stated as the mechanism rather than as a promise."
      />
      <CardBody className="space-y-4">
        <p className="text-sm text-text-muted">
          Every API key carries its environment, and every payment row carries that same value next
          to the network it settles on. A check constraint on the payments table ties the two
          together, so a test key is physically unable to produce a mainnet payment: the row is
          rejected by the database. This is not the application choosing to behave. No bug, no
          retry, no direct insert and no misconfigured deployment can route around it, because
          nothing in the application is consulted.
        </p>

        <div className="rounded-lg border border-border bg-surface-sunken p-4">
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            The constraint
          </p>
          <pre
            tabIndex={0}
            role="region"
            aria-label="The environment and network check constraint on the payments table"
            className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed text-text"
          >
            {CONSTRAINT_SOURCE}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-muted">
            This session holds a {environment} key, so its payments can settle only on:
          </span>
          {allowed.map((network) => (
            <span
              key={network}
              className="tabular rounded-full border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs text-text"
            >
              {network}
            </span>
          ))}
        </div>

        <p className="text-sm text-text-muted">
          The receiving addresses are separated the same way. Each environment has its own encrypted
          wallet seed, bound to that environment as authenticated data, so a test seed moved into
          the live slot fails to decrypt rather than quietly deriving live addresses.
        </p>
      </CardBody>
    </Card>
  );
}
