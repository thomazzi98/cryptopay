'use client';

import { useEffect, useState } from 'react';

import { classNames } from '@/lib/class-names';
import { formatDuration, secondsUntil } from '@/lib/format';

/**
 * The window a customer has left.
 *
 * The first value comes from the server clock and the browser takes over on hydration, which is why
 * the figure is marked as allowed to differ: the two clocks are never identical and a hydration
 * warning about one second of drift would be noise on a page that must not look broken.
 */

const URGENT_SECONDS = 120;

function describeRemaining(totalSeconds: number): string {
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  return formatDuration(totalSeconds);
}

export function ExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const remaining = secondsUntil(expiresAt, now);

  return (
    <span
      suppressHydrationWarning
      className={classNames(
        'tabular text-sm font-medium',
        remaining === 0 && 'text-status-expired',
        remaining > 0 && remaining <= URGENT_SECONDS && 'text-status-underpaid',
        remaining > URGENT_SECONDS && 'text-text',
      )}
    >
      {remaining === 0 ? 'window closed' : `${describeRemaining(remaining)} left`}
    </span>
  );
}
