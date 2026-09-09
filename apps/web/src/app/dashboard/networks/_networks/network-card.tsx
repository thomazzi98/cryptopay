'use client';

import type { NetworkDescriptor } from '@cryptopay/shared';

import { Copyable } from '@/components/ui/data';
import { Card, CardBody, CardHeader } from '@/components/ui/surfaces';
import { classNames } from '@/lib/class-names';
import { formatTimestamp } from '@/lib/format';

/**
 * One chain, and whether it is actually working.
 *
 * The failure this screen exists to make visible is a halted scanner. Nothing else in the product
 * shows it: payments keep being created, the API keeps answering, and not one of them is ever
 * detected, because the process that would notice stopped. An operator reading a list of pending
 * payments has no way to tell that from a quiet afternoon.
 *
 * Capabilities are shown rather than assumed. Three chains do genuinely different things, and a
 * merchant asking why they cannot take a memo on Polygon deserves an answer better than silence.
 */

const CAPABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  supportsNativePayments: 'Native currency',
  supportsTokenPayments: 'Tokens',
  supportsPaymentUri: 'Payment URI',
  supportsEventMonitoring: 'Monitoring',
  supportsFinalityTracking: 'Finality tag',
  supportsMemo: 'Memo',
  supportsSettlement: 'Settlement',
});

/**
 * A network is stale when its scanner has not written for longer than this. Deliberately generous:
 * a scanner polls on an interval, so a few missed ticks is a slow endpoint rather than an outage,
 * and an alarm that cries wolf is one nobody reads.
 */
const STALE_AFTER_MILLISECONDS = 120_000;

function Capability({ name, granted }: { name: string; granted: boolean }) {
  return (
    <span
      className={classNames(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
        granted
          ? 'border-border bg-surface-sunken text-text'
          : 'border-border/60 bg-transparent text-text-subtle',
      )}
    >
      <span aria-hidden="true">{granted ? '+' : '-'}</span>
      {CAPABILITY_LABELS[name] ?? name}
      <span className="sr-only">{granted ? 'supported' : 'not supported'}</span>
    </span>
  );
}

function ScanState({ network }: { network: NetworkDescriptor }) {
  if (network.scan.halted) {
    return (
      <p role="alert" className="text-sm text-status-underpaid">
        Scanning has halted on this network. Payments here will be created and never detected until
        an operator resumes it.
        {network.scan.haltedReason === null ? '' : ` Reason: ${network.scan.haltedReason}.`}
      </p>
    );
  }

  const observedAt = new Date(network.scan.updatedAt);
  const isStale = Date.now() - observedAt.getTime() > STALE_AFTER_MILLISECONDS;

  return (
    <p className={classNames('text-sm', isStale ? 'text-health-degraded' : 'text-text-muted')}>
      {isStale
        ? `No scan has been recorded since ${formatTimestamp(network.scan.updatedAt)}, which is longer than expected.`
        : `Scanning normally, last advanced ${formatTimestamp(network.scan.updatedAt)}.`}
    </p>
  );
}

export function NetworkCard({ network }: { network: NetworkDescriptor }) {
  const nativeCurrency = network.nativeCurrency.symbol;
  const tokens = network.assets.map((asset) => asset.symbol);
  const currencies = network.capabilities.supportsNativePayments
    ? [nativeCurrency, ...tokens]
    : tokens;

  return (
    <Card>
      <CardHeader
        title={network.displayName}
        description={`${network.networkFamily} family, ${network.environment} environment.`}
      />
      <CardBody className="space-y-4">
        <ScanState network={network} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Accepts
            </dt>
            <dd className="mt-0.5 text-sm text-text">
              {currencies.length === 0 ? 'nothing configured' : currencies.join(', ')}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Confirmations
            </dt>
            <dd className="tabular mt-0.5 text-sm text-text">
              {network.requiredConfirmations}
              {network.requiresFinalityTag ? ' plus finality' : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Scanned to
            </dt>
            <dd className="tabular mt-0.5 text-sm text-text">{network.scan.lastScannedHeight}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">Final</dt>
            <dd className="tabular mt-0.5 text-sm text-text">
              {network.scan.finalizedHeight ?? 'not published'}
            </dd>
          </div>
        </dl>

        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            What this chain can do
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(network.capabilities).map(([name, granted]) => (
              <Capability key={name} name={name} granted={granted} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
            Chain identity
          </p>
          <div className="mt-1">
            {network.ledgerIdentity === null ? (
              <p className="text-xs text-text-muted">
                None configured, so this network cannot be scanned from configuration.
              </p>
            ) : (
              <Copyable value={network.ledgerIdentity} />
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">
            Asserted before scanning starts. An endpoint serving a different chain stops the worker
            rather than producing payments that could never be confirmed.
            {network.chainIdentifier === null
              ? ' This family identifies itself by a genesis reference rather than a number.'
              : ` EVM chain ${network.chainIdentifier}.`}
          </p>
        </div>

        {network.assets.length > 0 && (
          <div>
            <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Tokens credited
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {network.assets.map((asset) => (
                <li key={asset.reference} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-text">{asset.symbol}</span>
                  <Copyable value={asset.reference} />
                  <span className="text-text-muted">{asset.decimals} decimals</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-text-muted">
              A token is identified by this address and never by the symbol it reports, because more
              than one contract reports the same symbol.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
