import { expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider, type Locale } from '@wp/ui';
import { ConnectSheet } from '../ConnectSheet.js';

/**
 * connect-sheet-test-helpers.ts (P08 U7; P26b security follow-up added the
 * Router/QueryClient wrapping - `useConnectFlow`'s MFA "sign in again" action
 * needs both) - shared fixtures/render helper for `connect-sheet.test.tsx`
 * and `connect-sheet-no-free-slot.test.tsx`, split out so neither test file
 * needs to duplicate this setup (and to keep both files under the
 * workspace's 300-line max-lines rule).
 */
export const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
export const HOLDER_ID = '22222222-2222-4222-8222-222222222222';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A never-resolving SSE response, for a test's `fetch` mock to return for any
 * `/v1/events...` request. `useLinkStream` (fix, 2026-09-16) now acquires an
 * additional instance-scoped realtime connection
 * (`lib/sse-instance-stream.ts`) for the whole time the Connect sheet holds
 * an `activeInstanceId`, so every test that reaches the challenge/linking
 * stage triggers a real `fetch('/v1/events?instanceId=...')` call. Tests that
 * only care about the REST flow (not the realtime stream itself) hand this
 * back so that call resolves to an inert, never-closing stream instead of
 * falling through to the mock's `unexpected fetch` throw - matching how
 * `sse.test.ts`'s own fixtures model a "connection stays open, nothing to
 * assert about it" case.
 */
export function neverEndingSseResponse(): Response {
  return new Response(new ReadableStream({ pull: () => undefined }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function renderConnectSheet(locale: Locale = 'en'): void {
  const rootRoute = createRootRoute({
    component: () => <ConnectSheet open onOpenChange={() => undefined} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

/** Drives the sheet from its initial 'create' stage through to the QR challenge stage. */
export async function createInstanceAndChooseQr(label = 'Sales'): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('connect-label-input')).not.toBeNull();
  });
  fireEvent.change(screen.getByTestId('connect-label-input'), { target: { value: label } });
  fireEvent.click(screen.getByTestId('connect-create-button'));

  await waitFor(() => {
    expect(screen.getByTestId('connect-method-qr')).not.toBeNull();
  });
  fireEvent.click(screen.getByTestId('connect-method-qr'));
}
