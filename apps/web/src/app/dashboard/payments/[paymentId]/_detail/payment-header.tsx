'use client';

import type { Payment, PaymentStatus } from '@cryptopay/shared';
import { formatBaseUnits } from '@cryptopay/shared';
import type { ReactNode } from 'react';

import { Amount, Copyable, Field } from '@/components/ui/data';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/surfaces';
import { formatRelative, formatTimestamp, truncateReference } from '@/lib/format';
import { describeStatus } from '@/lib/payment-status';

import { ExternalLink } from './external-link';
import { useNow } from './use-now';

/**
 * Everything a merchant checks before answering a customer, in one place: what was asked for, what
 * actually arrived, which address it was asked for at, and whether those two amounts agree. The
 * difference between requested and credited is stated in words rather than left for the reader to
 * subtract, because that subtraction is the question this screen exists to answer.
 */

const SETTLEMENT_LABELS: Readonly<Record<Payment['settlementStatus'], string>> = Object.freeze({
  not_started: 'Not started',
  funding_gas: 'Funding gas',
  sweeping: 'Sweeping',
  settled: 'Settled',
  failed: 'Failed',
});

function describeDifference(payment: Payment): string {
  const requested = BigInt(payment.requestedAmount.baseUnits);
  const credited = BigInt(payment.creditedAmount.baseUnits);

  if (credited === requested) {
    return 'Exactly the amount requested.';
  }

  const symbol = payment.asset.symbol;
  if (credited < requested) {
    const shortfall = formatBaseUnits(requested - credited, payment.asset.decimals);
    return `${shortfall} ${symbol} short of the amount requested.`;
  }
  const excess = formatBaseUnits(credited - requested, payment.asset.decimals);
  return `${excess} ${symbol} more than was requested.`;
}

function Absent({ label }: { label: string }) {
  return <span className="text-sm text-text-subtle">{label}</span>;
}

export function PaymentHeader({
  payment,
  status,
  action,
}: {
  payment: Payment;
  status: PaymentStatus | null;
  action: ReactNode;
}) {
  const now = useNow();
  const metadataEntries = Object.entries(payment.metadata);
  const band = payment.acceptanceBand;
  const decimals = payment.asset.decimals;

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            {status === null ? (
              <span className="rounded-full border border-border bg-surface-sunken px-3 py-1 text-sm text-text-muted">
                {payment.status}
              </span>
            ) : (
              <StatusBadge status={status} size="large" />
            )}
            <Copyable value={payment.identifier} display={payment.identifier} />
          </div>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {status === null
              ? 'This status is not one this dashboard knows how to describe.'
              : describeStatus(status).summary}
          </p>
        </div>
        {action}
      </div>

      <div className="grid gap-5 border-t border-border px-5 py-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">Requested</p>
          <p className="mt-1 text-2xl">
            <Amount
              display={payment.requestedAmount.display}
              symbol={payment.asset.symbol}
              emphasis="strong"
            />
          </p>
          <p className="tabular mt-1 text-xs text-text-subtle">
            Accepted between {formatBaseUnits(BigInt(band.minimumBaseUnits), decimals)} and
            {` ${formatBaseUnits(BigInt(band.maximumBaseUnits), decimals)} `}
            {payment.asset.symbol}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">Credited</p>
          <p className="mt-1 text-2xl">
            <Amount
              display={payment.creditedAmount.display}
              symbol={payment.asset.symbol}
              emphasis="strong"
            />
          </p>
          <p className="mt-1 text-xs text-text-muted">{describeDifference(payment)}</p>
        </div>
      </div>

      <dl className="grid gap-5 border-t border-border px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Receiving address" className="sm:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <Copyable value={payment.receivingAccount} />
            {payment.explorerAccountUrl !== null && (
              <ExternalLink
                href={payment.explorerAccountUrl}
                title={payment.receivingAccount}
                className="text-xs"
              >
                Explorer
              </ExternalLink>
            )}
          </div>
          <p className="mt-1 text-xs text-text-subtle">Allocated to this payment alone.</p>
        </Field>

        <Field label="Network">
          <span className="tabular">{payment.network}</span>
          <span className="tabular ml-2 text-xs text-text-subtle">
            chain {payment.chainIdentifier}
          </span>
        </Field>

        <Field label="Asset">
          <div className="flex flex-wrap items-center gap-2">
            <span>{payment.asset.symbol}</span>
            <Copyable value={payment.asset.reference} />
          </div>
          <p className="tabular mt-1 text-xs text-text-subtle">
            {payment.asset.decimals} decimals. The contract address is the identity, never the
            symbol.
          </p>
        </Field>

        <Field label="Created">
          <span className="tabular text-sm">{formatTimestamp(payment.createdAt)}</span>
        </Field>

        <Field label="Expires">
          <span className="tabular text-sm">{formatTimestamp(payment.expiresAt)}</span>
          {now !== null && (
            <span className="mt-1 block text-xs text-text-subtle">
              {formatRelative(payment.expiresAt, now)}
            </span>
          )}
        </Field>

        <Field label="Completed">
          {payment.completedAt === null ? (
            <Absent label="Not yet" />
          ) : (
            <span className="tabular text-sm">{formatTimestamp(payment.completedAt)}</span>
          )}
        </Field>

        <Field label="Status version">
          <span className="tabular">{payment.statusVersion}</span>
          <p className="mt-1 text-xs text-text-subtle">
            Discard any webhook that carries a lower one.
          </p>
        </Field>

        <Field label="Settlement sweep">
          <span className="text-sm">{SETTLEMENT_LABELS[payment.settlementStatus]}</span>
          <p className="mt-1 text-xs text-text-subtle">
            Moving the funds onward. Independent of the payment status.
          </p>
        </Field>

        <Field label="Merchant reference">
          {payment.merchantReference === null ? (
            <Absent label="None" />
          ) : (
            <span className="text-sm break-all">{payment.merchantReference}</span>
          )}
        </Field>

        <Field label="Callback URL" className="sm:col-span-2">
          {payment.callbackUrl === null ? (
            <Absent label="None. No webhook is sent for this payment." />
          ) : (
            <span className="font-mono text-xs break-all text-text-muted">
              {payment.callbackUrl}
            </span>
          )}
        </Field>

        <Field label="Checkout link">
          <ExternalLink
            href={payment.checkoutUrl}
            title={payment.checkoutUrl}
            className="font-mono text-xs"
          >
            {truncateReference(payment.checkoutUrl, 22, 8)}
          </ExternalLink>
        </Field>

        <Field label="Metadata" className="sm:col-span-2 lg:col-span-4">
          {metadataEntries.length === 0 ? (
            <Absent label="None" />
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {metadataEntries.map(([key, value]) => (
                <li
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-2 py-0.5 font-mono text-xs"
                >
                  <span className="text-text-subtle">{key}</span>
                  <span className="text-text">{value}</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
    </Card>
  );
}
