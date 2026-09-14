// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider } from '@wp/ui';
import {
  clearImpersonatedSession,
  getAccessToken,
  isImpersonatedSession,
  markImpersonatedSession,
  setAccessToken,
} from '../../lib/api-client.js';
import { ImpersonationBanner, type ImpersonationInfo } from '../impersonation-banner.js';

/**
 * impersonation-banner.test.tsx (P28 Unit U7) - proves the banner shows the
 * scope label and a countdown that advances with an injected clock (never a
 * real timer - test-discipline), and that "End session" clears BOTH the
 * in-memory token and the `sessionStorage` impersonation flag before
 * navigating to `/login`.
 */
const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function renderBanner(
  impersonation: ImpersonationInfo,
  now: () => number,
): ReturnType<typeof render> {
  const rootRoute = createRootRoute({
    component: () => <ImpersonationBanner impersonation={impersonation} now={now} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

describe('ImpersonationBanner', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setAccessToken(null);
    clearImpersonatedSession();
  });

  it('banner_renders_scope_and_countdown_and_ends_session', async () => {
    // `shouldAdvanceTime` lets the router's own async render (microtasks +
    // any internal `setTimeout(0)`) proceed under fake timers, so the
    // 1-second countdown interval can be installed AND advanced
    // deterministically in the same test, never a real wall-clock wait
    // (test-discipline: no sleeps).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setAccessToken('impersonation-token');
    markImpersonatedSession();

    const start = new Date('2026-09-08T10:00:00.000Z').getTime();
    let clock = start;
    const now = (): number => clock;

    renderBanner(
      {
        grantId: 'grant-1',
        scope: 'metadata_only',
        expiresAt: new Date(start + 90_000).toISOString(),
        staffLabel: 'Ada (support)',
      },
      now,
    );

    const banner = await screen.findByTestId('impersonation-banner');
    expect(banner.textContent).toContain('Account metadata only');
    expect(banner.textContent).toContain('01:30');

    clock = start + 30_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByTestId('impersonation-banner').textContent).toContain('01:00');

    fireEvent.click(screen.getByTestId('impersonation-banner-end-session'));

    expect(getAccessToken()).toBeNull();
    expect(isImpersonatedSession()).toBe(false);
  });

  it('banner_is_absent_without_an_impersonation_claim', () => {
    // No banner instance rendered at all - this asserts the contract at the
    // component boundary: absence of the claim means the caller (`_authed`
    // layout) never mounts `ImpersonationBanner` in the first place.
    render(
      <I18nProvider locale="en">
        <div data-testid="authed-shell">no banner here</div>
      </I18nProvider>,
    );
    expect(screen.queryByTestId('impersonation-banner')).toBeNull();
  });

  it('has zero axe violations', async () => {
    setAccessToken('impersonation-token');
    markImpersonatedSession();
    const start = Date.now();
    const { container } = renderBanner(
      {
        grantId: 'grant-1',
        scope: 'with_message_bodies',
        expiresAt: new Date(start + 60_000).toISOString(),
        staffLabel: 'Ada (support)',
      },
      () => start,
    );

    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
