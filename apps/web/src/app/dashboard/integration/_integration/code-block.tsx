'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { classNames } from '@/lib/class-names';

/**
 * Every sample on this page is meant to be pasted into a terminal or an editor, so the copy control
 * carries the exact text rendered and never a reflowed version of it: a signature computed over a
 * body that lost a byte in transit fails for a reason nobody can see.
 */
export function CodeBlock({
  label,
  code,
  className,
}: {
  label: string;
  code: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <figure
      className={classNames(
        'overflow-hidden rounded-lg border border-border bg-surface-sunken',
        className,
      )}
    >
      <figcaption className="flex items-center justify-between gap-4 border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-text-subtle">{label}</span>
        <Button
          variant="ghost"
          size="small"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </figcaption>
      <pre className="tabular overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-text">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
