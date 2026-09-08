'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Polling, deliberately, rather than a server-sent event stream.
 *
 * A dropped SSE connection fails silently: the confirmation counter simply stops moving, and to the
 * customer watching it that is indistinguishable from a payment that is stuck. A poll that fails is
 * a poll that retries, and the interface can say when it last succeeded.
 *
 * The client is created inside the component rather than at module scope so that a server render and
 * the render that follows it never share a cache, which would leak one reader's data into another's
 * page.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Nothing here is cacheable for long: a payment's status is the whole point of the
            // screen and it changes underneath the reader.
            staleTime: 0,
            gcTime: 60_000,
            refetchOnWindowFocus: true,
            retry: 2,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
