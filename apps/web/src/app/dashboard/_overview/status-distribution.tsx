import { StatusBadge } from '@/components/ui/status-badge';
import { describeStatus } from '@/lib/payment-status';

import type { StatusShare } from './metrics';

/**
 * Only the statuses actually present get a row. A list padded out with eight zeroes reads as a
 * legend rather than as data, and the two statuses that matter stop standing out in it.
 */
export function StatusDistribution({ distribution }: { distribution: readonly StatusShare[] }) {
  return (
    <ul className="space-y-3">
      {distribution.map((entry) => (
        <li key={entry.status} className="grid grid-cols-[9.5rem_1fr_auto] items-center gap-3">
          <StatusBadge status={entry.status} />

          <div
            className="h-2 overflow-hidden rounded-full bg-surface-sunken"
            role="img"
            aria-label={`${describeStatus(entry.status).label}: ${entry.count.toString()} payments, ${entry.share.toFixed(1)} percent`}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(entry.share, 1).toString()}%`,
                backgroundColor: describeStatus(entry.status).token,
              }}
            />
          </div>

          <p className="tabular text-xs text-text-muted">
            <span className="font-medium text-text">{entry.count}</span>
            <span className="ml-2 text-text-subtle">{entry.share.toFixed(1)}%</span>
          </p>
        </li>
      ))}
    </ul>
  );
}
