'use client';

import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { Separator } from '@base-ui/react/separator';
import { cx } from './lib/cx.js';

/**
 * DropdownMenu - Base UI Menu (ADR 0007) wired to a declarative `items` list
 * (actions, separators and group labels). Base UI provides roving-focus
 * arrow-key navigation, `Enter` to select and `Escape` to close; this
 * component only maps `items` to `Menu.Item`/`Menu.Separator`/
 * `Menu.GroupLabel` and applies the visual language. Carries `'use client'`:
 * renders via controlled open state and forwards `onSelect` handlers.
 */
export interface DropdownMenuAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type DropdownMenuItem = DropdownMenuAction | { separator: true } | { group: string };

export interface DropdownMenuProps {
  trigger: React.ReactElement;
  items: DropdownMenuItem[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}

function isSeparator(item: DropdownMenuItem): item is { separator: true } {
  return 'separator' in item;
}

function isGroupLabel(item: DropdownMenuItem): item is { group: string } {
  return 'group' in item;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
}: DropdownMenuProps): React.JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner align={align} side={side} sideOffset={6} className="outline-none">
          <Menu.Popup
            className={cx(
              'min-w-[12rem] rounded-lg border border-border bg-surface p-1 font-ui text-fg shadow-md',
              'transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
              'data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {items.map((item, index) => {
              if (isSeparator(item)) {
                return (
                  <Separator key={`separator-${String(index)}`} className="my-1 h-px bg-border" />
                );
              }
              if (isGroupLabel(item)) {
                return (
                  <div
                    key={`group-${item.group}`}
                    role="presentation"
                    className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle"
                  >
                    {item.group}
                  </div>
                );
              }
              return (
                <Menu.Item
                  key={item.id}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={cx(
                    'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                    'data-[highlighted]:bg-surface-2',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                    item.destructive ? 'text-danger' : 'text-fg',
                  )}
                >
                  {item.icon ? (
                    <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut ? (
                    <span className="text-xs text-subtle">{item.shortcut}</span>
                  ) : null}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
