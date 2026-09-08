'use client';

import { useState } from 'react';

import { classNames } from '@/lib/class-names';
import { formatAmount, formatExactAmount, truncateReference } from '@/lib/format';

/**
 * The two things this interface shows more than anything else: a figure and a reference.
 *
 * Both have the same rule. What is displayed is shortened for reading; what is carried underneath is
 * exact, because the shortened form is not the value and the person reading it is reconciling
 * against a bank statement or a block explorer.
 */

export function Amount({
  display,
  symbol,
  emphasis = 'normal',
  className,
}: {
  display: string;
  symbol?: string;
  emphasis?: 'normal' | 'strong' | 'muted';
  className?: string;
}) {
  const exact = formatExactAmount(display);
  return (
    <span
      title={symbol === undefined ? exact : `${exact} ${symbol}`}
      className={classNames(
        'tabular whitespace-nowrap',
        emphasis === 'strong' && 'font-semibold text-text',
        emphasis === 'muted' && 'text-text-muted',
        className,
      )}
    >
      {formatAmount(display)}
      {symbol !== undefined && <span className="ml-1 text-text-subtle">{symbol}</span>}
    </span>
  );
}

/**
 * A reference someone needs to paste elsewhere. The full value is what gets copied and what the
 * title carries; only the visible form is elided, and it is elided in the middle so both ends remain
 * comparable against a block explorer.
 */
export function Copyable({
  value,
  display,
  className,
}: {
  value: string;
  display?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      // A clipboard blocked by permissions is not worth interrupting anyone over, and the full value
      // is still selectable through the title.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={value}
      aria-label={`Copy ${value}`}
      className={classNames(
        'tabular inline-flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 font-mono text-xs',
        'text-text-muted transition-colors hover:bg-surface-hover hover:text-text',
        className,
      )}
    >
      {display ?? truncateReference(value)}
      <span aria-hidden="true" className="text-[10px] opacity-70">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}

/** A labelled figure, used wherever a screen states one fact about a payment. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames('min-w-0', className)}>
      <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-text">{children}</dd>
    </div>
  );
}
