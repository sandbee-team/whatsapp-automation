import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CommandPalette, useT, type CommandPaletteItem } from '@wp/ui';
import { NAV_GROUPS } from './nav-config.js';

/**
 * CommandPaletteHost (P26b U2, design brief section 3) - `Ctrl/Cmd+K` opens
 * a `CommandPalette` built from `NAV_GROUPS`; selecting an item navigates.
 * `Escape` closing is handled by `CommandPalette`/`Dialog` itself; this host
 * only owns the open/close state and the global key listener.
 */
export interface CommandPaletteHostProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPaletteHost({
  open,
  onOpenChange,
}: CommandPaletteHostProps): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();

  React.useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const isModifierK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      if (isModifierK) {
        event.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  const items: CommandPaletteItem[] = NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: item.testId,
      label: t(item.labelKey),
      group: t(group.labelKey),
      icon: <item.icon aria-hidden size={16} />,
      onSelect: () => {
        void navigate({ to: item.to as never });
      },
    })),
  );

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      placeholder={t('shell.commandPalette.placeholder')}
      emptyLabel={t('shell.commandPalette.empty')}
      inputLabel={t('shell.commandPalette.inputLabel')}
    />
  );
}
