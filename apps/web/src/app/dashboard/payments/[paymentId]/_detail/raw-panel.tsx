'use client';

import type { Payment } from '@cryptopay/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * The resource as the API returned it, unformatted and unfiltered.
 *
 * This is the tab an integrator opens when their own parser disagrees with the screen above, so
 * nothing is prettied up beyond indentation and no field is omitted. It is also the fastest way to
 * hand support the exact body a merchant is seeing.
 */
export function RawPanel({ payment }: { payment: Payment }) {
  const [copied, setCopied] = useState(false);
  const serialized = JSON.stringify(payment, null, 2);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-xs text-text-muted">
          The payment resource exactly as GET /v1/payments answered it.
        </p>
        <Button
          size="small"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </Button>
      </div>

      <pre className="tabular max-h-[32rem] overflow-auto rounded-lg border border-border bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-text">
        {serialized}
      </pre>
    </div>
  );
}
