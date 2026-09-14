'use client';

import * as React from 'react';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cx } from './lib/cx.js';

/**
 * Tabs - Base UI Tabs (ADR 0007) driven by a declarative `tabs` list. Base UI
 * provides roving-focus arrow-key navigation between tab buttons. Carries
 * `'use client'`: forwards `onValueChange` and renders via controlled value.
 */
export interface TabItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  disabled?: boolean;
}

export type TabsVariant = 'underline' | 'pill';

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  variant?: TabsVariant;
  children?: React.ReactNode;
}

const LIST_VARIANT_CLASSES: Record<TabsVariant, string> = {
  underline: 'gap-6 border-b border-border',
  pill: 'gap-1 rounded-lg bg-surface-2 p-1',
};

const TAB_VARIANT_CLASSES: Record<TabsVariant, string> = {
  underline:
    'border-b-2 border-transparent pb-2 data-[selected]:border-accent data-[selected]:text-fg text-muted',
  pill: 'rounded-md px-3 py-1.5 data-[selected]:bg-surface data-[selected]:text-fg data-[selected]:shadow-sm text-muted',
};

export function Tabs({
  tabs,
  value,
  onValueChange,
  variant = 'underline',
  children,
}: TabsProps): React.JSX.Element {
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as string)}>
      <BaseTabs.List className={cx('flex items-center', LIST_VARIANT_CLASSES[variant])}>
        {tabs.map((tab) => (
          <BaseTabs.Tab
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className={cx(
              'flex items-center gap-2 text-sm font-medium outline-none transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
              'disabled:opacity-50 disabled:pointer-events-none',
              TAB_VARIANT_CLASSES[variant],
            )}
          >
            {tab.icon ? (
              <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
                {tab.icon}
              </span>
            ) : null}
            {tab.label}
            {tab.count !== undefined ? (
              <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-xs text-muted">
                {tab.count}
              </span>
            ) : null}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}

export interface TabsPanelProps {
  value: string;
  children?: React.ReactNode;
}

export function TabsPanel({ value, children }: TabsPanelProps): React.JSX.Element {
  return (
    <BaseTabs.Panel value={value} className="pt-4">
      {children}
    </BaseTabs.Panel>
  );
}
