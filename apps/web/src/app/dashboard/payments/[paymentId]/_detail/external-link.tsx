import type { ReactNode } from 'react';

import { classNames } from '@/lib/class-names';

/** Anything leaving the dashboard opens detached from it and cannot reach back through the opener. */
export function ExternalLink({
  href,
  title,
  className,
  children,
}: {
  href: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className={classNames(
        'rounded-lg text-accent underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-accent',
        className,
      )}
    >
      {children}
    </a>
  );
}
