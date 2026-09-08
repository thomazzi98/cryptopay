'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { classNames } from '@/lib/class-names';

/**
 * The current section is marked with `aria-current` as well as a colour change, so the position is
 * announced rather than only seen. Matching is by segment rather than by prefix: a plain prefix test
 * lights up "Payments" while the reader is on the webhooks screen.
 */

const SECTIONS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/payments', label: 'Payments' },
  { href: '/dashboard/webhooks', label: 'Webhooks' },
  { href: '/dashboard/simulator', label: 'Simulator' },
  { href: '/dashboard/integration', label: 'Integration' },
  { href: '/dashboard/settings', label: 'Settings' },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  if (href === '/dashboard') {
    return pathname === '/dashboard';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Dashboard sections" className="mx-auto max-w-7xl px-4 sm:px-6">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {SECTIONS.map((section) => {
          const current = isCurrent(pathname, section.href);
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={current ? 'page' : undefined}
                className={classNames(
                  'inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
                  current
                    ? 'border-accent font-medium text-text'
                    : 'border-transparent text-text-muted hover:border-border-strong hover:text-text',
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
