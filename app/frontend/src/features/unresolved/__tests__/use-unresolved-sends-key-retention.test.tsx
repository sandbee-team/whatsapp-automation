// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, ToastProvider } from '@wp/ui';
import * as unresolvedApi from '../api.js';
import { UnresolvedSendsPanel } from '../UnresolvedSendsPanel.js';

/**
 * use-unresolved-sends-key-retention.test.tsx (P26b C1 fix round MINOR-15) -
 * `useUnresolvedSends.ts` previously cleared the row's `Idempotency-Key` on
 * ANY `ApiError`, including a 5xx. Narrowed to terminal 4xx only (status
 * 400-499) - a 5xx keeps the key so the user's manual retry click reuses it,
 * same idiom as `useComposer.ts`/`broadcast-detail.tsx`. Exercised through
 * `UnresolvedSendsPanel` (the hook's only consumer) with the real `apiFetch`
 * seam mocked at `global.fetch`, same idiom as
 * `unresolved-sends-panel.test.tsx`.
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const ROW_A = {
  jobPublicId: 'job-public-id-a',
  createdAt: '2026-09-01T10:00:00.000Z',
  instanceId: INSTANCE_ID,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPanel(): void {
  render(
    <I18nProvider locale="en">
      <ToastProvider>
        <UnresolvedSendsPanel instanceId={INSTANCE_ID} />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('useUnresolvedSends key retention on 5xx vs terminal 4xx', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a_5xx_failure_keeps_the_key_so_a_manual_retry_reuses_it', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A],
    });

    const seenKeys: (string | undefined)[] = [];
    let callCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
      seenKeys.push(key);
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }, 500),
        );
      }
      return Promise.resolve(jsonResponse({ data: { id: 'job-public-id-a', status: 'queued' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`));
    await waitFor(() => expect(seenKeys).toHaveLength(1));

    // Retry the SAME row after the 5xx failure.
    fireEvent.click(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`));
    await waitFor(() => expect(seenKeys).toHaveLength(2));

    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBe(seenKeys[0]);
  });

  it('a_terminal_4xx_clears_the_key_so_the_next_retry_mints_a_fresh_one', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A],
    });

    const seenKeys: (string | undefined)[] = [];
    let callCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
      seenKeys.push(key);
      if (callCount === 1) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'CONFLICT', message: 'nope', requestId: 'r' } }, 409),
        );
      }
      return Promise.resolve(jsonResponse({ data: { id: 'job-public-id-a', status: 'queued' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`));
    await waitFor(() => expect(seenKeys).toHaveLength(1));

    fireEvent.click(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`));
    await waitFor(() => expect(seenKeys).toHaveLength(2));

    expect(seenKeys[0]).toBeTruthy();
    expect(seenKeys[1]).toBeTruthy();
    expect(seenKeys[1]).not.toBe(seenKeys[0]);
  });
});
