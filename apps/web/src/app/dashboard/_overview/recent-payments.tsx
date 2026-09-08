import Link from 'next/link';

import { Amount } from '@/components/ui/data';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatRelative, truncateReference } from '@/lib/format';

import type { OverviewPayment } from './metrics';

/**
 * The merchant reference is shown where the merchant put one, because that is the string they know
 * the order by. The payment identifier is the fallback rather than the default: it means something
 * to this API and nothing to the person reconciling an order.
 */
export function RecentPayments({
  payments,
  now,
}: {
  payments: readonly OverviewPayment[];
  now: number;
}) {
  return (
    <ul className="divide-y divide-border">
      {payments.map((payment) => (
        <li key={payment.identifier}>
          <Link
            href={`/dashboard/payments/${payment.identifier}`}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-hover sm:grid-cols-[10rem_1fr_auto_auto] sm:gap-4"
          >
            <StatusBadge status={payment.status} />

            <span className="min-w-0 truncate text-sm text-text-muted">
              {payment.merchantReference ?? (
                <span className="tabular font-mono text-xs">
                  {truncateReference(payment.identifier, 10, 6)}
                </span>
              )}
            </span>

            <Amount
              display={payment.requestedAmount.display}
              symbol={payment.asset.symbol}
              emphasis="strong"
              className="text-sm"
            />

            <span
              title={payment.createdAt}
              className="tabular col-span-3 text-xs text-text-subtle sm:col-span-1 sm:text-right"
            >
              {formatRelative(payment.createdAt, now)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
