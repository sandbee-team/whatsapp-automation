// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { UNRESOLVED_DISCARD_BUTTON_COPY, UNRESOLVED_RETRY_BUTTON_COPY } from '@wp/domain';
import { UnresolvedSendsPanel } from '../UnresolvedSendsPanel.js';
import { setAccessToken } from '../../../lib/api-client.js';
import * as unresolvedApi from '../api.js';

/**
 * unresolved-sends-panel.test.tsx (P12 U6a) - follows `composer.test.tsx`'s
 * (network mocked at `apiFetch`'s one seam, `global.fetch`) and
 * `empty-dashboard.test.tsx`'s (honest empty/loading/error states) idiom.
 * `fetchUnresolvedSends` is spied directly (rather than mocked at
 * `fetch`) because it is a client-side-only stub today (no `GET` list
 * route exists - see `api.ts`'s doc comment); the retry/discard actions
 * still go through the real `apiFetch` seam via `global.fetch`.
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

describe('UnresolvedSendsPanel', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setAccessToken(null);
  });

  it('the_panel_renders_both_canon_buttons_with_their_exact_wording', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`).textContent).toBe(
      UNRESOLVED_RETRY_BUTTON_COPY,
    );
    expect(screen.getByTestId(`unresolved-discard-${ROW_A.jobPublicId}`).textContent).toBe(
      UNRESOLVED_DISCARD_BUTTON_COPY,
    );
  });

  it('the_panel_shows_the_unresolved_count_for_the_instance', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A, { ...ROW_A, jobPublicId: 'job-public-id-b' }],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('unresolved-count').textContent).toBe('2');
    });
  });

  it('the_panel_never_renders_a_phone_number_jid_or_message_body', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-row-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    const panelText = screen.getByTestId('unresolved-sends-panel').textContent ?? '';
    expect(panelText).not.toContain('+91');
    expect(panelText).not.toContain('@s.whatsapp.net');
    expect(panelText).not.toContain('hello there');
  });

  it('retry_and_discard_each_send_exactly_one_request_with_an_idempotency_key', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A, { ...ROW_A, jobPublicId: 'job-public-id-b' }],
    });

    const seenRequests: { url: string; key: string | undefined }[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
      seenRequests.push({ url, key });
      return Promise.resolve(jsonResponse({ data: { id: 'job-public-id-a', status: 'queued' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`));

    await waitFor(() => {
      expect(seenRequests).toHaveLength(1);
    });
    const [retryRequest] = seenRequests;
    expect(retryRequest?.url).toContain('/unresolved/retry');
    expect(retryRequest?.key).toBeTruthy();

    fireEvent.click(screen.getByTestId('unresolved-discard-job-public-id-b'));

    await waitFor(() => {
      expect(seenRequests).toHaveLength(2);
    });
    const discardRequest = seenRequests[1];
    expect(discardRequest?.url).toContain('/unresolved/discard');
    expect(discardRequest?.key).toBeTruthy();
    expect(discardRequest?.key).not.toBe(retryRequest?.key);
  });

  it('a_double_click_does_not_fire_two_retries', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [ROW_A],
    });

    const pendingFetch: { resolve: ((response: Response) => void) | null } = { resolve: null };
    const fetchMock = vi.fn(() => {
      return new Promise<Response>((resolve) => {
        pendingFetch.resolve = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`)).not.toBeNull();
    });

    const retryButton = screen.getByTestId(`unresolved-retry-${ROW_A.jobPublicId}`);
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    pendingFetch.resolve?.(jsonResponse({ data: { id: 'job-public-id-a', status: 'queued' } }));
  });

  it('honest_loading_state_before_the_list_resolves', () => {
    const pendingList: { release: (() => void) | null } = { release: null };
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockReturnValue(
      new Promise((resolve) => {
        pendingList.release = () => resolve({ source: 'unavailable', rows: [] });
      }),
    );

    renderPanel();

    expect(screen.getByTestId('unresolved-loading')).not.toBeNull();
    expect(screen.queryByTestId('unresolved-empty')).toBeNull();
    pendingList.release?.();
  });

  it('honest_empty_state_when_there_are_genuinely_no_unresolved_sends', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockResolvedValue({
      source: 'unavailable',
      rows: [],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('unresolved-empty')).not.toBeNull();
    });
    expect(screen.queryByTestId('unresolved-loading')).toBeNull();
  });

  it('honest_error_state_when_the_list_source_rejects', async () => {
    vi.spyOn(unresolvedApi, 'fetchUnresolvedSends').mockRejectedValue(new Error('boom'));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('unresolved-error')).not.toBeNull();
    });
    expect(screen.queryByTestId('unresolved-loading')).toBeNull();
  });
});
