'use client';

import * as React from 'react';
import { t as translate, type Locale, type MessageKey } from '@wp/i18n';

/**
 * React adapter for `@wp/i18n` (which deliberately carries no React import -
 * design doc `@wp/i18n` section). `useT()` returns a bound
 * `(key, vars?) => t(key, vars, locale)`, so callers never pass `locale`
 * themselves.
 */

export interface I18nContextValue {
  locale: Locale;
}

const I18nContext = React.createContext<I18nContextValue | undefined>(undefined);

export interface I18nProviderProps {
  locale: Locale;
  children: React.ReactNode;
}

export function I18nProvider({ locale, children }: I18nProviderProps): React.JSX.Element {
  const value = React.useMemo<I18nContextValue>(() => ({ locale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18nContext(): I18nContextValue {
  const context = React.useContext(I18nContext);
  if (!context) {
    throw new Error('useLocale/useT must be used within an <I18nProvider>');
  }
  return context;
}

export function useLocale(): Locale {
  return useI18nContext().locale;
}

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): TFunction {
  const { locale } = useI18nContext();
  return React.useCallback<TFunction>((key, vars) => translate(key, vars, locale), [locale]);
}
