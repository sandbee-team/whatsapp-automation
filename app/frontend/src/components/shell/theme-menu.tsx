'use client';

import * as React from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { DropdownMenu, IconButton, useT, type DropdownMenuItem } from '@wp/ui';
import { useTheme, type ThemeChoice } from '../../providers/theme-provider.js';

/**
 * ThemeMenu (panel refresh spec section 4, unit S1) - a `DropdownMenu` whose
 * trigger is an `IconButton` (`data-testid="theme-switch"`) showing the icon
 * for the CURRENT choice (Sun/Moon/Monitor); items are System/Light/Dark,
 * each carrying a check-mark icon on the currently selected choice. Replaces
 * the earlier native `<select>` - the spec bans native selects in the shell.
 * `DropdownMenu`'s `Menu.Item` does not forward a `data-testid` prop (see
 * `packages/ui/src/dropdown-menu.tsx`), so tests select an item by its
 * accessible name (`getByRole('menuitem', { name })`) rather than a testid,
 * same idiom as the sibling `UserMenu`'s "Log out" item.
 */
const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

const THEME_TRIGGER_ICON: Record<ThemeChoice, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function ThemeMenu(): React.JSX.Element {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const TriggerIcon = THEME_TRIGGER_ICON[theme];

  const labelForChoice: Record<ThemeChoice, string> = {
    system: t('shell.theme.system'),
    light: t('shell.theme.light'),
    dark: t('shell.theme.dark'),
  };

  const items: DropdownMenuItem[] = THEME_ORDER.map((choice) => ({
    id: `theme-option-${choice}`,
    label: labelForChoice[choice],
    icon: theme === choice ? <Check aria-hidden size={16} /> : undefined,
    onSelect: () => setTheme(choice),
  }));

  return (
    <DropdownMenu
      align="end"
      trigger={
        <IconButton data-testid="theme-switch" aria-label={t('shell.theme.trigger')} size="sm">
          <TriggerIcon aria-hidden size={16} strokeWidth={1.75} />
        </IconButton>
      }
      items={items}
    />
  );
}

export { THEME_ORDER };
