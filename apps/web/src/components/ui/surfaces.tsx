import type { ReactNode } from 'react';

import { classNames } from '@/lib/class-names';

/**
 * The surfaces every screen is built from.
 *
 * Elevation is a hairline border and one soft shadow, never a gradient: a gradient behind a column
 * of figures shifts their apparent weight down the column, and these are figures people compare.
 */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={classNames(
        'rounded-xl border border-border bg-surface-raised shadow-(--shadow-raised)',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description !== undefined && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={classNames('px-5 py-4', className)}>{children}</div>;
}

/**
 * Stands in for the content while it loads, in the same shape, so nothing moves when the data
 * lands. A spinner in the middle of an empty page tells a reader nothing about what is coming.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={classNames('skeleton rounded-lg', className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={classNames('space-y-2 p-4', className)}>
      {Array.from({ length: rows }, (unused, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}

/**
 * Empty and failed are told apart deliberately.
 *
 * "No payments yet" and "your payments could not be loaded" render identically if both are an empty
 * table, and a merchant who sees the first while the second is true concludes they have lost money.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-text">{title}</p>
      <p className="max-w-md text-sm text-text-muted">{description}</p>
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'This could not be loaded',
  detail,
  action,
}: {
  title?: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center"
    >
      <p className="text-sm font-medium text-status-canceled">{title}</p>
      <p className="max-w-md text-sm text-text-muted">{detail}</p>
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}
