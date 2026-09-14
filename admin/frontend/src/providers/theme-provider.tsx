import * as React from 'react';

/**
 * providers/theme-provider.tsx (P28 Unit U6, step 9) - byte-identical
 * behaviour to app/frontend's ThemeProvider: `light`/`dark`/`system`,
 * persisted to `localStorage['wp-admin.theme']` (try/catch-wrapped, default
 * `'system'`), applied as `data-theme` on `<html>`. A distinct storage key
 * (`wp-admin.*` vs `wp.*`) keeps the two panels' preferences independent even
 * when opened from the same browser profile.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'wp-admin.theme';
const DEFAULT_THEME: ThemeChoice = 'system';

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function writeStoredTheme(theme: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing / disabled storage - theme still applies for this
    // page load via React state, it just will not persist.
  }
}

export interface ThemeContextValue {
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a <ThemeProvider>');
  }
  return context;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = React.useState<ThemeChoice>(() =>
    typeof window === 'undefined' ? DEFAULT_THEME : readStoredTheme(),
  );

  const setTheme = React.useCallback((next: ThemeChoice) => {
    setThemeState(next);
    writeStoredTheme(next);
  }, []);

  React.useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const value = React.useMemo<ThemeContextValue>(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
