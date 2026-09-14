import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { NAV_GROUPS } from '../../src/components/shell/nav-config.js';

/**
 * journey-support.ts (P26b U6) - route table + screenshot/dialog helpers for
 * `journey.spec.ts`, split out to respect the workspace's max-lines: 300
 * lint rule. Deterministic-by-construction: every wait is `expect`/
 * `expect.poll`/`waitForURL`, never a fixed `sleep` (see `waitForSettled`,
 * copied from `route-screenshots.spec.ts`).
 */

export interface JourneyRoute {
  /** Slug used only for screenshot filenames (never a selector). */
  name: string;
  /** The nav item's own `data-testid` (`nav-config.ts`) - clicked verbatim, never re-derived. */
  navTestId: string;
  screenTestId: string;
}

const SCREEN_TEST_ID_BY_PATH: Readonly<Record<string, string>> = {
  '/': 'dashboard-screen',
  '/instances': 'instances-screen',
  '/messages': 'composer',
  '/unresolved': 'unresolved-sends-screen',
  '/broadcasts': 'broadcasts-screen',
  '/contacts': 'contacts-screen',
  '/groups': 'groups-route-screen',
  '/settings/security': 'security-screen',
  '/settings/webhooks': 'webhooks-screen',
  '/wallet': 'wallet-screen',
};

/** One entry per `NAV_GROUPS` item, in the exact rendered order - every route ships a name AND its real testid. */
export const NAV_ROUTES: readonly JourneyRoute[] = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({
    name: item.to === '/' ? 'dashboard' : item.to.replace(/^\//, '').replace(/\//g, '-'),
    navTestId: item.testId,
    screenTestId: SCREEN_TEST_ID_BY_PATH[item.to] ?? 'main',
  })),
);

/**
 * The shared SSE stream keeps a request open for the shell's whole life, so
 * `networkidle` never settles - wait for the screen root to appear and for
 * every `*-loading` placeholder / `aria-busy` element to clear instead (same
 * idiom as `route-screenshots.spec.ts`).
 */
export async function waitForSettled(page: Page, screenTestId: string): Promise<void> {
  await expect(page.getByTestId(screenTestId)).toBeVisible();
  await expect
    .poll(() => page.locator('[data-testid$="-loading"], [aria-busy="true"]').count(), {
      timeout: 15_000,
    })
    .toBe(0);
}

export function resolveShotDir(here: string): string {
  return path.resolve(here, process.env.WP_SHOT_DIR ?? '../../../../docs/evidence/P26b-ui/after');
}

export function ensureShotDir(shotDir: string): void {
  mkdirSync(shotDir, { recursive: true });
}

async function shot(page: Page, shotDir: string, name: string): Promise<void> {
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true });
}

/**
 * Captures light + dark full-page shots at the current viewport, restoring
 * `system` theme after. `ThemeMenu`'s trigger keeps `data-testid="theme-
 * switch"`; its `DropdownMenu` items (`packages/ui/src/dropdown-menu.tsx`,
 * outside this unit's file scope) render no `data-testid` on `Menu.Item`, so
 * options are selected by their accessible menuitem name instead.
 */
export async function shotLightAndDark(page: Page, shotDir: string, name: string): Promise<void> {
  await shot(page, shotDir, name);
  await page.getByTestId('theme-switch').click();
  await page.getByRole('menuitem', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(page, shotDir, `${name}-dark`);
  await page.getByTestId('theme-switch').click();
  await page.getByRole('menuitem', { name: 'System' }).click();
}

/** Captures a 390x844 light-mode mobile shot without disturbing the desktop viewport (restored by the caller). */
export async function shotMobile(page: Page, shotDir: string, name: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, shotDir, `${name}-mobile`);
}
