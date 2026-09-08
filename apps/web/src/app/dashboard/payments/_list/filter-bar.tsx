'use client';

import { isPaymentStatus, isNetworkIdentifier } from '@cryptopay/shared';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
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
