// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { PageHeader } from '../page-header.js';

/**
 * page-header.test.tsx (P26b U2 contract) - renders title/description/
 * actions/breadcrumbs/tabs per the contract's anatomy.
 */
function renderHeader(ui: React.ReactElement): void {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
}

describe('PageHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders_title_description_actions_breadcrumbs_and_tabs', async () => {
    renderHeader(
      <PageHeader
        title="Numbers"
        description="Connect and manage your WhatsApp numbers."
        breadcrumbs={[{ label: 'Overview', to: '/' }, { label: 'Numbers' }]}
        actions={<button type="button">Connect a number</button>}
        tabs={<div data-testid="header-tabs">tabs row</div>}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Numbers' })).not.toBeUndefined();
    expect(screen.getByText('Connect and manage your WhatsApp numbers.')).not.toBeUndefined();
    expect(screen.getByRole('button', { name: 'Connect a number' })).not.toBeUndefined();
    expect(screen.getByRole('link', { name: 'Overview' })).not.toBeUndefined();
    expect(screen.getByText('Numbers', { selector: 'span' })).not.toBeUndefined();
    expect(screen.getByTestId('header-tabs')).not.toBeUndefined();
  });

  it('renders_without_optional_props', async () => {
    renderHeader(<PageHeader title="Dashboard" />);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).not.toBeUndefined();
  });

  it('renders_the_eyebrow_above_the_title_when_given', async () => {
    renderHeader(<PageHeader title="Numbers" eyebrow="Workspace" />);
    expect(await screen.findByRole('heading', { name: 'Numbers' })).not.toBeUndefined();
    expect(screen.getByText('Workspace')).not.toBeUndefined();
  });
});
