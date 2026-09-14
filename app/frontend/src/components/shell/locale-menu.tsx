'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { DropdownMenu, useT, type DropdownMenuItem } from '@wp/ui';
import type { Locale } from '@wp/i18n';
import { useAppLocale } from '../../providers/i18n-provider.js';

/**
 * LocaleMenu (panel refresh spec section 4, unit S1) - a `DropdownMenu`
 * whose trigger is a small pill showing `EN` / `हि` for the current locale
 * (`data-testid="locale-switch"`); items are English/Hindi with a check-mark
 * icon on the current choice. Replaces the earlier native `<select>` - see
 * `ThemeMenu`'s doc comment for why item selection in tests uses the
 * accessible name rather than a `data-testid`.
 */
const LOCALE_ORDER: Locale[] = ['en', 'hi'];

const LOCALE_PILL_LABEL: Record<Locale, string> = {
  en: 'EN',
  hi: 'हि',
};

export function LocaleMenu(): React.JSX.Element {
  const t = useT();
  const { locale, setLocale } = useAppLocale();

  const labelForLocale: Record<Locale, string> = {
    en: t('shell.locale.optionEn'),
    hi: t('shell.locale.optionHi'),
  };

  const items: DropdownMenuItem[] = LOCALE_ORDER.map((code) => ({
    id: `locale-option-${code}`,
    label: labelForLocale[code],
    icon: locale === code ? <Check aria-hidden size={16} /> : undefined,
    onSelect: () => setLocale(code),
  }));

  return (
    <DropdownMenu
      align="end"
      trigger={
        <button
          type="button"
          data-testid="locale-switch"
          aria-label={t('shell.locale.trigger')}
          className="flex h-8 min-w-8 items-center justify-center rounded-full border border-border-strong bg-surface px-2 font-ui text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        >
          {LOCALE_PILL_LABEL[locale]}
        </button>
      }
      items={items}
    />
  );
}
