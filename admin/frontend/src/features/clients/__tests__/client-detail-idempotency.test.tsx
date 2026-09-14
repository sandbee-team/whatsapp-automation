// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ClientHeaderActions } from '../components/client-header-actions.js';
import { CLIENT, okMutationResponse, renderWithRole } from './client-detail-fixtures.js';

/**
 * client-detail-idempotency.test.tsx (P28 Unit U6, step 9) - the third
 * required proof, split from `client-detail.test.tsx` for the 300-line cap:
 * a mutation sends ONE idempotency key, identical across the automatic
 * 401->refresh->retry, and the body carries the reason both times.
 */
describe('a_mutation_sends_one_idempotency_key_and_the_reason', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the Idempotency-Key header is identical across the automatic 401->refresh->retry, and the body carries the reason', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    let refreshed = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        refreshed = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                accessToken: 'new-token',
                expiresInSeconds: 120,
                staffId: 's1',
                fullName: 'Staff One',
                role: 'superadmin',
                actions: [],
              },
              meta: { requestId: 'req-refresh' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }

      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, headers, body });

      if (url.includes('/suspend') && !refreshed) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(okMutationResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithRole('superadmin', <ClientHeaderActions clientId={CLIENT.id} status="active" />);

    fireEvent.click(await screen.findByTestId('client-detail-suspend'));
    fireEvent.change(await screen.findByTestId('reason-field'), {
      target: { value: 'suspending for review' },
    });
    await waitFor(() => {
      expect((screen.getByTestId('staff-action-submit') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('staff-action-submit'));

    await waitFor(() => {
      expect(calls.length).toBe(2);
    });

    const [firstAttempt, retryAttempt] = calls;
    expect(firstAttempt!.headers['Idempotency-Key']).toBeTruthy();
    expect(firstAttempt!.headers['Idempotency-Key']).toBe(retryAttempt!.headers['Idempotency-Key']);
    expect((firstAttempt!.body as { reason: string }).reason).toBe('suspending for review');
    expect((retryAttempt!.body as { reason: string }).reason).toBe('suspending for review');
  });
});
