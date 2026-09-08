'use client';

import {
  isPaymentStatus,
  isTerminalPaymentStatus,
  type Payment,
  type PaymentList,
} from '@cryptopay/shared';
import {
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorState } from '@/components/ui/surfaces';
import { ApiError, callApi } from '@/lib/api-client';
import { formatShortTimestamp } from '@/lib/format';

import { FilterBar } from './filter-bar';
import {
  buildListPath,
  hasActiveFilter,
  readFilters,
  writeFilters,
  type PaymentFilters,
} from './filters';
import { PaymentsTable, PaymentsTableSkeleton } from './payments-table';

/**
 * The payments list.
 *
 * Pagination is a cursor, so the control is "load more" rather than a page number. The API returns
 * `hasMore` and `nextCursor` and no total; numbered pages would be an invention that stops being
 * true the moment a payment is created while someone is reading page four. Each page the reader has
 * opened stays loaded as its own query, so a refresh re-reads every page on screen instead of
 * collapsing the list back to the first one.
 *
 * What the reader opens is a page count, never a set of cursors. The API pages with `id < cursor`
 * over `ORDER BY id DESC`, so a cursor kept from an earlier fetch stops lining up as soon as newer
 * payments shift the first page, and the rows either side of the seam are duplicated or skipped.
 * Every cursor is re-derived from the page before it on each render, so a refresh re-chains the
 * whole list against the answers that just came back.
 *
 * The refresh runs only while something on screen can still move. Once every loaded payment is in a
 * terminal state there is no answer left to ask for, and polling on regardless is one request per
 * reader per interval for a result that is already final.
 */

const LIST_ROUTE = '/dashboard/payments';
const PAGE_SIZE = 25;
const POLL_INTERVAL_MILLISECONDS = 6000;

const FIRST_PAGE_KEY = 'first';

function pageQueryKey(filterKey: string, cursor: string | null): readonly string[] {
  return ['payments', filterKey, cursor ?? FIRST_PAGE_KEY];
}

function buildCursorChain(
  queryClient: QueryClient,
  filterKey: string,
  openedPageCount: number,
): readonly (string | null)[] {
  const chain: (string | null)[] = [null];
  let cursor: string | null = null;

  while (chain.length < openedPageCount) {
    const page: PaymentList | undefined = queryClient.getQueryData<PaymentList>(
      pageQueryKey(filterKey, cursor),
    );
    if (page === undefined || !page.hasMore || page.nextCursor === null) {
      return chain;
    }
    cursor = page.nextCursor;
    chain.push(cursor);
  }

  return chain;
}

function isLivePayment(payment: Payment): boolean {
  return isPaymentStatus(payment.status) && !isTerminalPaymentStatus(payment.status);
}

function describeFailure(failure: unknown): string {
  if (failure instanceof ApiError) {
    return failure.detail;
  }
  if (failure instanceof Error) {
    return failure.message;
  }
  return 'The payments list could not be loaded.';
}

interface LoadedPages {
  readonly rows: readonly Payment[];
  readonly isPending: boolean;
  readonly isAppending: boolean;
  readonly isFetching: boolean;
  readonly failure: unknown;
  readonly nextCursor: string | null;
  readonly refreshedAt: number;
}

function combinePages(results: readonly UseQueryResult<PaymentList, Error>[]): LoadedPages {
  const firstPage = results[0];
  const lastPage = results.at(-1)?.data;

  return {
    rows: results.flatMap((result) => result.data?.data ?? []),
    // Only the first page may replace the table with a skeleton. A page being appended leaves the
    // rows the reader is looking at exactly where they are.
    isPending: firstPage === undefined || firstPage.isPending,
    isAppending: results.slice(1).some((result) => result.isPending),
    isFetching: results.some((result) => result.isFetching),
    failure: results.find((result) => result.error !== null)?.error,
    nextCursor: lastPage?.hasMore === true ? lastPage.nextCursor : null,
    refreshedAt: Math.max(0, ...results.map((result) => result.dataUpdatedAt)),
  };
}

export function PaymentsExplorer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const filterKey = searchParams.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(filterKey)), [filterKey]);

  // Every filter change starts the list again at one page: a cursor from one filtered list means
  // nothing in another.
  const [openedPageCount, setOpenedPageCount] = useState(1);
  const [loadedFilterKey, setLoadedFilterKey] = useState(filterKey);
  if (loadedFilterKey !== filterKey) {
    setLoadedFilterKey(filterKey);
    setOpenedPageCount(1);
  }

  const cursors = buildCursorChain(queryClient, filterKey, openedPageCount);

  const pages = useQueries({
    queries: cursors.map((cursor) => ({
      queryKey: pageQueryKey(filterKey, cursor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        callApi<PaymentList>(buildListPath(filters, cursor, PAGE_SIZE), { signal }),
    })),
    combine: combinePages,
  });

  const isPolling = pages.rows.some((payment) => isLivePayment(payment));

  useEffect(() => {
    if (!isPolling) {
      return;
    }
    const timer = setInterval(() => {
      void queryClient.refetchQueries({ queryKey: ['payments', filterKey] });
    }, POLL_INTERVAL_MILLISECONDS);
    return () => {
      clearInterval(timer);
    };
  }, [isPolling, filterKey, queryClient]);

  const applyFilters = useCallback(
    (next: PaymentFilters) => {
      const nextQuery = writeFilters(next);
      router.replace(nextQuery === '' ? LIST_ROUTE : `${LIST_ROUTE}?${nextQuery}`, {
        scroll: false,
      });
    },
    [router],
  );

  const clearFilters = useCallback(() => {
    router.replace(LIST_ROUTE, { scroll: false });
  }, [router]);

  const loadMore = useCallback(() => {
    setOpenedPageCount((count) => count + 1);
  }, []);

  const isEmpty = !pages.isPending && pages.failure === undefined && pages.rows.length === 0;

  return (
    <Card>
      <FilterBar filters={filters} onChange={applyFilters} onClear={clearFilters} />

      {pages.isPending && <PaymentsTableSkeleton />}

      {pages.failure !== undefined && (
        <ErrorState
          title="The payments list could not be loaded"
          detail={describeFailure(pages.failure)}
          action={
            <Button
              loading={pages.isFetching}
              onClick={() => {
                void queryClient.refetchQueries({ queryKey: ['payments', filterKey] });
              }}
            >
              Try again
            </Button>
          }
        />
      )}

      {isEmpty && hasActiveFilter(filters) && (
        <EmptyState
          title="No payments match these filters"
          description="Nothing in this environment matches the status, network and reference selected above."
          action={
            <Button variant="secondary" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      )}

      {isEmpty && !hasActiveFilter(filters) && (
        <EmptyState
          title="No payments yet"
          description="A payment appears here as soon as this key creates one. The simulator can drive one end to end without touching a real wallet."
        />
      )}

      {pages.rows.length > 0 && <PaymentsTable payments={pages.rows} />}

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="text-xs text-text-muted">
          {/* The count answers something the reader did. The timestamp moves on its own every six
              seconds, and announcing the sentence around it turns a background poll into an
              interruption, so the live region stops at the count. */}
          <span aria-live="polite">
            <span className="tabular">{pages.rows.length}</span>
            {pages.rows.length === 1 ? ' payment loaded' : ' payments loaded'}
          </span>
          {pages.refreshedAt > 0 && (
            <>
              {' - refreshed '}
              <span className="tabular">
                {formatShortTimestamp(new Date(pages.refreshedAt).toISOString())}
              </span>
            </>
          )}
          {isPolling && (
            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">
              Live
            </span>
          )}
        </p>

        {pages.nextCursor !== null && (
          <Button variant="secondary" size="small" loading={pages.isAppending} onClick={loadMore}>
            Load more
          </Button>
        )}
      </div>
    </Card>
  );
}
