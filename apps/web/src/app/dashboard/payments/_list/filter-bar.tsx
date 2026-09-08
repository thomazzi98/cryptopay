'use client';

import { isPaymentStatus, isNetworkIdentifier } from '@cryptopay/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/surfaces';
import { STATUS_DISPLAY_ORDER, describeStatus } from '@/lib/payment-status';

import {
  SELECTABLE_NETWORKS,
  describeNetwork,
  hasActiveFilter,
  type PaymentFilters,
} from './filters';

/**
 * The controls that write the URL.
 *
 * The reference search is debounced before it reaches the router: typing eight characters would
 * otherwise push eight history entries and fire eight list requests, and the last one is the only
 * answer anybody wanted.
 */

const SEARCH_DEBOUNCE_MILLISECONDS = 350;

const CONTROL_CLASS =
  'rounded-lg border border-border bg-surface-raised px-2.5 py-2 text-sm text-text transition-colors hover:border-border-strong';

const LABEL_CLASS = 'text-xs font-medium tracking-wide text-text-subtle uppercase';

export function FilterBar({
  filters,
  onChange,
  onClear,
}: {
  filters: PaymentFilters;
  onChange: (next: PaymentFilters) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(filters.merchantReference);

  useEffect(() => {
    setDraft(filters.merchantReference);
  }, [filters.merchantReference]);

  const commitReference = useCallback(
    (merchantReference: string) => {
      onChange({ ...filters, merchantReference });
    },
    [filters, onChange],
  );

  useEffect(() => {
    if (draft === filters.merchantReference) {
      return;
    }
    const timer = setTimeout(() => {
      commitReference(draft.trim());
    }, SEARCH_DEBOUNCE_MILLISECONDS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, filters.merchantReference, commitReference]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <label className="flex items-center gap-2 text-xs font-medium text-text-subtle">
        <span className="tracking-wide uppercase">Status</span>
        <select
          className={CONTROL_CLASS}
          value={filters.status ?? ''}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange({ ...filters, status: isPaymentStatus(chosen) ? chosen : null });
          }}
        >
          <option value="">Any status</option>
          {STATUS_DISPLAY_ORDER.map((status) => (
            <option key={status} value={status}>
              {describeStatus(status).label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-xs font-medium text-text-subtle">
        <span className="tracking-wide uppercase">Network</span>
        <select
          className={CONTROL_CLASS}
          value={filters.network ?? ''}
          onChange={(event) => {
            const chosen = event.target.value;
            onChange({ ...filters, network: isNetworkIdentifier(chosen) ? chosen : null });
          }}
        >
          <option value="">Any network</option>
          {SELECTABLE_NETWORKS.map((network) => (
            <option key={network} value={network}>
              {describeNetwork(network)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-56 flex-1 items-center gap-2 text-xs font-medium text-text-subtle">
        <span className="tracking-wide uppercase">Reference</span>
        <input
          type="search"
          value={draft}
          placeholder="Search merchant reference"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitReference(draft.trim());
            }
          }}
          className={`${CONTROL_CLASS} w-full font-normal placeholder:text-text-subtle`}
        />
      </label>

      {hasActiveFilter(filters) && (
        <Button variant="ghost" size="small" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * The bar as it stands before the filters can be read from the URL. It exists so the loading state
 * has the same first child as the resolved one, and the table below it lands where it was drawn.
 */
export function FilterBarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <div className="flex items-center gap-2">
        <span className={LABEL_CLASS}>Status</span>
        <div className={CONTROL_CLASS}>
          <Skeleton className="h-5 w-24" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className={LABEL_CLASS}>Network</span>
        <div className={CONTROL_CLASS}>
          <Skeleton className="h-5 w-28" />
        </div>
      </div>

      <div className="flex min-w-56 flex-1 items-center gap-2">
        <span className={LABEL_CLASS}>Reference</span>
        <div className={`${CONTROL_CLASS} w-full`}>
          <Skeleton className="h-5 w-full" />
        </div>
      </div>
    </div>
  );
}
