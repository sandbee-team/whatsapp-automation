import * as React from 'react';
import { I18nProvider as UiI18nProvider, type Locale } from '@wp/ui';

/**
 * providers/i18n-provider.tsx (P28 Unit U6, step 9) - mirrors app/frontend's
 * AppI18nProvider. Owns the locale STATE: reads/writes
 * `localStorage['wp-admin.locale']` (try/catch-wrapped), defaults to `'en'`
 * when unset or invalid, and keeps `<html lang>` in sync via an effect.
 */
const LOCALE_STORAGE_KEY = 'wp-admin.locale';
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

export interface AdminLocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const AdminLocaleContext = React.createContext<AdminLocaleContextValue | undefined>(undefined);

export function useAdminLocale(): AdminLocaleContextValue {
  const context = React.useContext(AdminLocaleContext);
  if (!context) {
    throw new Error('useAdminLocale must be used within an <AdminI18nProvider>');
  }
  return context;
}

export function AdminI18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
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

  const value = React.useMemo<AdminLocaleContextValue>(
    () => ({ locale, setLocale }),
    [locale, setLocale],
  );

  return (
    <AdminLocaleContext.Provider value={value}>
      <UiI18nProvider locale={locale}>{children}</UiI18nProvider>
    </AdminLocaleContext.Provider>
  );
}
