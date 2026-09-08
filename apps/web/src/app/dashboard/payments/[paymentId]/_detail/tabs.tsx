'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { classNames } from '@/lib/class-names';

/**
 * Real tabs, not styled links.
 *
 * The pattern is the one the ARIA practices describe: one stop in the tab order for the whole strip,
 * arrows to move between tabs, and the panel wired to its tab in both directions. Every panel element
 * stays mounted so `aria-controls` always resolves to something, while only the selected one renders
 * its children, which is also what keeps three idle panels from polling the API.
 */

const PAYMENT_TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'raw', label: 'Raw JSON' },
] as const;

export type TabId = (typeof PAYMENT_TABS)[number]['id'];

export function isTabId(value: string): value is TabId {
  return PAYMENT_TABS.some((tab) => tab.id === value);
}

function tabElementId(tab: TabId): string {
  return `payment-tab-${tab}`;
}

function panelElementId(tab: TabId): string {
  return `payment-panel-${tab}`;
}

const KEY_MOVES: Readonly<Record<string, (position: number, length: number) => number>> =
  Object.freeze({
    ArrowRight: (position, length) => (position + 1) % length,
    ArrowLeft: (position, length) => (position - 1 + length) % length,
    Home: () => 0,
    End: (position, length) => length - 1,
  });

export function TabStrip({
  selected,
  onSelect,
}: {
  selected: TabId;
  onSelect: (tab: TabId) => void;
}) {
  const buttons = useRef(new Map<TabId, HTMLButtonElement>());

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const move = KEY_MOVES[event.key];
    if (move === undefined) {
      return;
    }
    event.preventDefault();

    const position = PAYMENT_TABS.findIndex((tab) => tab.id === selected);
    const target = PAYMENT_TABS[move(position, PAYMENT_TABS.length)];
    if (target === undefined) {
      return;
    }
    onSelect(target.id);
    buttons.current.get(target.id)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Payment detail sections"
      onKeyDown={handleKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-border px-2"
    >
      {PAYMENT_TABS.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node === null) {
                buttons.current.delete(tab.id);
                return;
              }
              buttons.current.set(tab.id, node);
            }}
            type="button"
            role="tab"
            id={tabElementId(tab.id)}
            aria-selected={isSelected}
            aria-controls={panelElementId(tab.id)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            className={classNames(
              '-mb-px border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors',
              isSelected
                ? 'border-accent font-medium text-text'
                : 'border-transparent text-text-muted hover:border-border-strong hover:text-text',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  tab,
  selected,
  children,
}: {
  tab: TabId;
  selected: TabId;
  children: ReactNode;
}) {
  const isSelected = tab === selected;
  return (
    <div
      id={panelElementId(tab)}
      role="tabpanel"
      aria-labelledby={tabElementId(tab)}
      tabIndex={0}
      hidden={!isSelected}
    >
      {isSelected ? children : null}
    </div>
  );
}
