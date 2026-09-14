// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { queryClient } from '../../providers/query-client.js';
import { setAccessToken } from '../../lib/api-client.js';
import * as apiClient from '../../lib/api-client.js';
import { routeTree } from '../../routeTree.gen.js';

/**
 * authed-guard.test.tsx (P05 U5, phase step 7) - proves an unauthenticated
 * visit to a protected route (`/`) redirects to `/login` BEFORE anything
 * protected renders, over the REAL route tree (not a hand-rolled stub), and
 * that no protected fetch is ever attempted along the way.
 */

describe('_authed guard', () => {
  beforeEach(() => {
    setAccessToken(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('an_unauthenticated_visit_to_a_protected_route_redirects_to_login', async () => {
    vi.spyOn(apiClient, 'ensureSession').mockResolvedValue(false);

    const fetchMock = vi.fn(() => {
      throw new Error('no protected fetch should ever be attempted before the redirect');
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });

    expect(screen.queryByTestId('empty-dashboard')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
