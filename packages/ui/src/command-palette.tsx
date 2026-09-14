'use client';

import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cx } from './lib/cx.js';

/**
 * CommandPalette - a Dialog-based filtered command list (ADR 0007's Dialog
 * primitive as the popup chrome, with a hand-rolled `role="combobox"` +
 * listbox instead of Base UI's Combobox: the brief calls for full control
 * over grouped rendering and `aria-activedescendant` wiring). Filtering is
 * case-insensitive substring match over label + keywords. Carries
 * `'use client'`: owns the active-index/query state and keyboard handling.
 */
export interface CommandPaletteItem {
  id: string;
  label: string;
  group?: string;
  icon?: React.ReactNode;
  keywords?: string[];
  shortcut?: string;
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandPaletteItem[];
  placeholder: string;
  emptyLabel: string;
  inputLabel: string;
}

function matchesQuery(item: CommandPaletteItem, query: string): boolean {
  if (query === '') return true;
  const haystack = [item.label, ...(item.keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function groupItems(items: CommandPaletteItem[]): Array<[string, CommandPaletteItem[]]> {
  const groups = new Map<string, CommandPaletteItem[]>();
  for (const item of items) {
    const key = item.group ?? '';
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  return Array.from(groups.entries());
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  placeholder,
  emptyLabel,
  inputLabel,
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(
    () => items.filter((item) => matchesQuery(item, query)),
    [items, query],
  );

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  const activeItem = filtered[activeIndex];

  function moveActive(delta: number): void {
    if (filtered.length === 0) return;
    setActiveIndex((current) => {
      const next = (current + delta + filtered.length) % filtered.length;
      return next;
    });
  }

  function runActive(): void {
    if (!activeItem) return;
    activeItem.onSelect();
    onOpenChange(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runActive();
    }
  }

  const groups = groupItems(filtered);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) setQuery('');
      }}
      modal
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-overlay transition-opacity duration-150 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          initialFocus={inputRef}
          aria-label={inputLabel}
          className={cx(
            'fixed left-1/2 top-24 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl',
            'bg-surface shadow-lg transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
            'data-[starting-style]:opacity-0',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <input
              ref={inputRef}
              role="combobox"
              aria-label={inputLabel}
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={activeItem ? `${listboxId}-${activeItem.id}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              placeholder={placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
            />
          </div>
          <ul id={listboxId} role="listbox" className="max-h-80 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted">{emptyLabel}</li>
            ) : (
              groups.map(([group, groupItemsList]) => (
                <li key={group || 'ungrouped'} role="presentation">
                  {group ? (
                    <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle">
                      {group}
                    </div>
                  ) : null}
                  <ul role="presentation">
                    {groupItemsList.map((item) => {
                      const index = filtered.indexOf(item);
                      const isActive = index === activeIndex;
                      return (
                        <li
                          key={item.id}
                          id={`${listboxId}-${item.id}`}
                          role="option"
                          aria-selected={isActive}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => {
                            item.onSelect();
                            onOpenChange(false);
                          }}
                          className={cx(
                            'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                            isActive ? 'bg-surface-2 text-fg' : 'text-fg',
                          )}
                        >
                          {item.icon ? (
                            <span
                              aria-hidden="true"
                              className="flex h-4 w-4 items-center justify-center"
                            >
                              {item.icon}
                            </span>
                          ) : null}
                          <span className="flex-1">{item.label}</span>
                          {item.shortcut ? (
                            <span className="text-xs text-subtle">{item.shortcut}</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
