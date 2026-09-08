'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '@/lib/class-names';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Readonly<Record<Variant, string>> = {
  primary: 'border-transparent bg-accent text-text-inverted hover:bg-accent-hover',
  secondary: 'border-border bg-surface-raised text-text hover:bg-surface-hover',
  ghost: 'border-transparent bg-transparent text-text-muted hover:bg-surface-hover hover:text-text',
  danger: 'border-border bg-transparent text-status-canceled hover:bg-status-canceled-soft',
};

export function Button({
  variant = 'secondary',
  size = 'default',
  loading = false,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'default' | 'small';
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      {...rest}
      // A button that is busy must also be unclickable, or a double submit is one impatient click
      // away. Both come from one flag so they cannot drift apart.
      disabled={disabled === true || loading}
      aria-busy={loading}
      className={classNames(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        size === 'small' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
