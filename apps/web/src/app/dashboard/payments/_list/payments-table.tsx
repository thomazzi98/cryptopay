'use client';

import { isPaymentStatus, type Payment } from '@cryptopay/shared';
import Link from 'next/link';

import { Amount } from '@/components/ui/data';
import { Skeleton } from '@/components/ui/surfaces';
import { StatusBadge } from '@/components/ui/status-badge';
import { classNames } from '@/lib/class-names';
import { formatShortTimestamp, truncateReference } from '@/lib/format';
import { describeStatus } from '@/lib/payment-status';

import { describeNetwork } from './filters';

/**
 * A list of links laid out on a grid, rather than a table, for one reason: the whole row is the
 * link target.
 *
 * An anchor cannot wrap a `tr`, and an anchor stretched over a row with absolute positioning misses
 * in enough browsers to be a bug rather than a detail. The grid keeps the columns aligned and lets
 * each row be a single link, so the click target is the row a reader is already pointing at.
 *
 * There are no table ARIA roles here on purpose. `role` overrides native semantics, so a `role="row"`
 * on the anchor exposes it as a row and never as a link: nothing tells a screen reader the row can
 * be opened, and it is missing from the links list. The rows are a `ul` and each link stays a link.
 */

const COLUMNS =
  'grid grid-cols-[8.5rem_minmax(7rem,1fr)_minmax(7rem,1fr)_8rem_minmax(9rem,1.2fr)_9rem_11rem] gap-4';

const HEADINGS = [
  'Status',
  'Requested',
  'Credited',
  'Network',
  'Reference',
  'Created',
  'Identifier',
] as const;

function accentToken(status: string): string {
  if (isPaymentStatus(status)) {
    return describeStatus(status).token;
  }
  return 'var(--color-border)';
}

function PaymentRow({ payment }: { payment: Payment }) {
  const isCredited = payment.creditedAmount.baseUnits !== '0';

  return (
    <Link
      href={`/dashboard/payments/${payment.identifier}`}
      className={classNames(
        COLUMNS,
        'items-center border-l-2 border-b border-border px-5 py-2.5 text-sm transition-colors',
        'hover:bg-surface-hover focus-visible:bg-surface-hover',
      )}
      style={{ borderLeftColor: accentToken(payment.status) }}
    >
      <span>
        {isPaymentStatus(payment.status) ? (
          <StatusBadge status={payment.status} />
        ) : (
          <span className="text-xs text-text-muted">{payment.status}</span>
        )}
      </span>

      <span className="text-right">
        <Amount
          display={payment.requestedAmount.display}
          symbol={payment.asset.symbol}
          emphasis="strong"
        />
      </span>

      <span className="text-right">
        <Amount
          display={payment.creditedAmount.display}
          symbol={payment.asset.symbol}
          emphasis={isCredited ? 'normal' : 'muted'}
        />
      </span>

      <span className="truncate text-text-muted">{describeNetwork(payment.network)}</span>

      <span className="truncate text-text">
        {payment.merchantReference ?? <span className="text-text-subtle">Not set</span>}
      </span>

      <span className="tabular text-text-muted">{formatShortTimestamp(payment.createdAt)}</span>

      {/* The elided form is for scanning; the title carries the value someone needs to paste. */}
      <span
        title={payment.identifier}
        className="tabular truncate font-mono text-xs text-text-subtle"
      >
        {truncateReference(payment.identifier, 10, 6)}
      </span>
    </Link>
  );
}

export function PaymentsTable({ payments }: { payments: readonly Payment[] }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-5xl">
        <div
          className={classNames(
            COLUMNS,
            'border-b border-border bg-surface-sunken px-5 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase',
          )}
        >
          {HEADINGS.map((heading) => (
            <span
              key={heading}
              className={classNames(
                'border-l-2 border-transparent',
                (heading === 'Requested' || heading === 'Credited') && 'text-right',
              )}
            >
              {heading}
            </span>
          ))}
        </div>

        <ul aria-label="Payments">
          {payments.map((payment) => (
            <li key={payment.identifier}>
              <PaymentRow payment={payment} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The loading state is the table with its figures missing, so nothing moves when the data lands. */
export function PaymentsTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-5xl">
        <div
          className={classNames(
            COLUMNS,
            'border-b border-border bg-surface-sunken px-5 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase',
          )}
        >
          {HEADINGS.map((heading) => (
            <span key={heading}>{heading}</span>
          ))}
        </div>
        {Array.from({ length: rows }, (unused, index) => (
          <div key={index} className={classNames(COLUMNS, 'border-b border-border px-5 py-3')}>
            {HEADINGS.map((heading) => (
              <Skeleton key={heading} className="h-4 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
