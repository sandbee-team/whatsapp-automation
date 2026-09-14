import * as React from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { StaffRoleContract } from '@wp/contracts';
import type { AdminClientDetail } from '../api.js';
import type { AdminInstanceItem } from '../../instances/api.js';

/**
 * client-detail-fixtures.tsx (P28 Unit U6, step 9) - shared fixtures for the
 * client-detail mutation-control test files (300-line-cap split: the tests
 * themselves stayed too close to the cap once every describe block lived in
 * one file).
 */
export const CLIENT: AdminClientDetail = {
  id: 'c1111111-1111-7111-8111-111111111111',
  companyName: 'Acme Co',
  slug: 'acme',
  status: 'active',
  onboardingStep: 'done',
  planKey: 'pro',
  planName: 'Pro',
  createdAt: '2026-01-01T00:00:00.000Z',
  timezone: 'Asia/Kolkata',
  limits: { plan: null, overrides: [] },
  pricing: null,
  wallet: {
    clientId: 'c1111111-1111-7111-8111-111111111111',
    state: 'active',
    currency: 'INR',
    balanceMinor: '100000',
    maxRateMinor: '500',
    lowThresholdMinor: '10000',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  instances: [],
  recentStaffActions: [],
  activeImpersonations: [],
};

export const INSTANCE: AdminInstanceItem = {
  id: 'i1111111-1111-7111-8111-111111111111',
  clientId: CLIENT.id,
  healthState: 'healthy',
  linkState: 'connected',
  desiredState: 'active',
  pauseReason: null,
  band: 'healthy',
  tier: 3,
  ownerWorkerId: 'worker-1',
  leaseSeenAt: '2026-01-01T00:00:00.000Z',
  queueDepth: 0,
  oldestQueuedAgeSeconds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

export function okMutationResponse(): Response {
  return new Response(
    JSON.stringify({ data: { ok: true, replayed: false }, meta: { requestId: 'req-1' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

export function renderWithRole(role: StaffRoleContract, ui: React.ReactNode): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    id: '/_authed',
    getParentRoute: () => rootRoute,
    loader: () => ({
      me: { staffId: 's1', fullName: 'Staff One', role, actions: [] },
    }),
  });
  const homeRoute = createRoute({
    path: '/home',
    getParentRoute: () => authedRoute,
    component: () => <>{ui}</>,
  });
  const routeTree = rootRoute.addChildren([authedRoute.addChildren([homeRoute])]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/home'] }),
  });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ToastProvider dismissLabel="Close">
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
