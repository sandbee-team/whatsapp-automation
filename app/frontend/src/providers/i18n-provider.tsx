import * as React from 'react';
import { I18nProvider as UiI18nProvider, type Locale } from '@wp/ui';

/**
 * providers/i18n-provider.tsx - app-level wrapper around `@wp/ui`'s
 * (controlled, locale-as-prop) `I18nProvider`. Owns the actual locale
 * STATE: reads/writes `localStorage['wp.locale']` (wrapped in try/catch -
 * private browsing / disabled storage must never crash the app), defaults
 * to `'en'` when unset or invalid, and keeps `<html lang>` in sync via an
 * effect (phase step 7: "`index.html`: `lang` follows locale").
 */

const LOCALE_STORAGE_KEY = 'wp.locale';
const DEFAULT_LOCALE: Locale = 'en';

function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'hi';
}

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private browsing / disabled storage - the locale still works for this
    // page load via React state, it just will not persist.
  }
}

export interface AppLocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const AppLocaleContext = React.createContext<AppLocaleContextValue | undefined>(undefined);

export function useAppLocale(): AppLocaleContextValue {
  const context = React.useContext(AppLocaleContext);
  if (!context) {
    throw new Error('useAppLocale must be used within an <AppI18nProvider>');
  }
  return context;
}

export function AppI18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = React.useState<Locale>(() =>
    typeof window === 'undefined' ? DEFAULT_LOCALE : readStoredLocale(),
  );

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = React.useMemo<AppLocaleContextValue>(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return (
    <AppLocaleContext.Provider value={value}>
      <UiI18nProvider locale={locale}>{children}</UiI18nProvider>
    </AppLocaleContext.Provider>
  );
}
