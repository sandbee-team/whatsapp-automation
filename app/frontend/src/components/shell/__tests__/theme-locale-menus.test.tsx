// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppI18nProvider } from '../../../providers/i18n-provider.js';
import { ThemeProvider } from '../../../providers/theme-provider.js';
import { ThemeMenu } from '../theme-menu.js';
import { LocaleMenu } from '../locale-menu.js';

/**
 * theme-locale-menus.test.tsx (panel refresh spec section 4, unit S1) -
 * proves both menus open, an option can be selected, and the underlying
 * provider value changes as a result: `ThemeMenu` calls `setTheme('dark')`
 * and applies `data-theme="dark"` to `<html>`; `LocaleMenu` selecting Hindi
 * switches the pill label to the Hindi text. `app/frontend` carries no
 * `@testing-library/user-event` dependency (only `packages/ui` does, and this
 * unit may not touch `app/frontend/package.json`), so this test uses
 * `fireEvent`, the same idiom as `app-shell.test.tsx`.
 */
function renderThemeMenu() {
  window.localStorage.clear();
  return render(
    <AppI18nProvider>
      <ThemeProvider>
        <ThemeMenu />
      </ThemeProvider>
    </AppI18nProvider>,
  );
}

function renderLocaleMenu() {
  window.localStorage.clear();
  return render(
    <AppI18nProvider>
      <LocaleMenu />
    </AppI18nProvider>,
  );
}

describe('ThemeMenu', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('opening_the_menu_and_selecting_dark_updates_the_document_theme', async () => {
    renderThemeMenu();

    fireEvent.click(screen.getByTestId('theme-switch'));
    const darkItem = await screen.findByRole('menuitem', { name: 'Dark' });
    fireEvent.click(darkItem);

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('selecting_system_removes_the_data_theme_attribute', async () => {
    renderThemeMenu();

    fireEvent.click(screen.getByTestId('theme-switch'));
    const darkItem = await screen.findByRole('menuitem', { name: 'Dark' });
    fireEvent.click(darkItem);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    fireEvent.click(screen.getByTestId('theme-switch'));
    const systemItem = await screen.findByRole('menuitem', { name: 'System' });
    fireEvent.click(systemItem);

    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  });
});

describe('LocaleMenu', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('opening_the_menu_and_selecting_hindi_switches_the_pill_label', async () => {
    renderLocaleMenu();

    expect(screen.getByTestId('locale-switch').textContent).toBe('EN');

    fireEvent.click(screen.getByTestId('locale-switch'));
    const hindiItem = await screen.findByRole('menuitem', { name: 'हिन्दी' });
    fireEvent.click(hindiItem);

    await waitFor(() => {
      expect(screen.getByTestId('locale-switch').textContent).toBe('हि');
    });
  });
});
