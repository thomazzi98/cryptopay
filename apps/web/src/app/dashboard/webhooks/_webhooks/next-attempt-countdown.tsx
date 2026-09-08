'use client';

import { formatDuration, formatTimestamp, secondsUntil } from '@/lib/format';

import { useClock } from './use-clock';

export function NextAttemptCountdown({ nextAttemptAt }: { nextAttemptAt: string }) {
  const now = useClock(1000);

  if (now === null) {
    return <span className="tabular text-text-subtle">--:--</span>;
  }

  const seconds = secondsUntil(nextAttemptAt, now);
  if (seconds === 0) {
    return (
      <span className="tabular text-text-muted" title={formatTimestamp(nextAttemptAt)}>
        due now
      </span>
    );
  }

  return (
    <span className="tabular text-text-muted" title={formatTimestamp(nextAttemptAt)}>
      retry in {formatDuration(seconds)}
    </span>
  );
}
