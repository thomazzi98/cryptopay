'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, seeded in an effect rather than during render, so the server-rendered markup and
 * the hydration that follows it cannot disagree about what "in 12 minutes" means. Null until the
 * browser has it, which is the signal to render the absolute timestamp alone.
 */
export function useNow(intervalMilliseconds = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMilliseconds);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMilliseconds]);

  return now;
}
