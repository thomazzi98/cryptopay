'use client';

import { Button } from '@/components/ui/button';

/**
 * A failed refresh must not take the content with it.
 *
 * This screen polls, and a poll that fails leaves the query in an error state while the last good
 * page is still held. Replacing a delivery log a merchant is reading with a full error panel is the
 * worse outcome of the two, so the failure is stated over the content it is stale against.
 */
export function RefreshFailureBanner({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-health-degraded bg-health-degraded-soft px-5 py-2.5"
    >
      <p className="text-xs text-health-degraded">
        This is the last successful load; refreshing it failed. {detail}
      </p>
      <Button size="small" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
