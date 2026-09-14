// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { I18nProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { Sidebar } from '../sidebar.js';

/**
 * admin-shell.test.tsx (P28 Unit U6, step 9) - the sidebar's nav + persistent
 * "STAFF CONSOLE" badge (present whether expanded or collapsed), and an axe
 * proof (`AXE_OPTIONS` idiom from `packages/ui/test/a11y.test.tsx`).
 */
const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: {
    'color-contrast': { enabled: false },
  },
};

function renderSidebar(collapsed = false) {
  const rootRoute = createRootRoute({
    component: () => <Sidebar collapsed={collapsed} onCollapsedChange={() => undefined} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/clients'] }),
  });
  return render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

describe('Sidebar', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders every nav group item with its link', async () => {
    renderSidebar();
    expect(await screen.findByTestId('nav-clients')).toBeTruthy();
    expect(screen.getByTestId('nav-instances')).toBeTruthy();
    expect(screen.getByTestId('nav-queue')).toBeTruthy();
    expect(screen.getByTestId('nav-topups')).toBeTruthy();
    expect(screen.getByTestId('nav-audit')).toBeTruthy();
  });

  it('always renders the STAFF CONSOLE badge, expanded or collapsed', async () => {
    renderSidebar(false);
    const expanded = await screen.findByTestId('staff-console-badge');
    expect(expanded.textContent).toBe('STAFF CONSOLE');
    cleanup();

    renderSidebar(true);
    const collapsed = await screen.findByTestId('staff-console-badge');
    expect(collapsed.textContent).toBe('STAFF CONSOLE');
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderSidebar();
    await screen.findByTestId('nav-clients');
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
