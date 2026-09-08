'use client';

import { useEffect, useState } from 'react';

/**
 * Wall-clock time, ticking, and null until the browser has it.
 *
 * A countdown rendered on the server disagrees with the countdown rendered a second later in the
 * browser, and React calls that a hydration error. Starting at null makes the first paint identical
 * on both sides and lets the caller render a dash for one frame.
 */
export function useClock(intervalMilliseconds: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const handle = setInterval(() => {
      setNow(Date.now());
    }, intervalMilliseconds);
    return () => {
      clearInterval(handle);
    };
  }, [intervalMilliseconds]);

  return now;
}
