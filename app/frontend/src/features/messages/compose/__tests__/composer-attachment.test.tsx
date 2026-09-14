// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { Composer } from '../Composer.js';
import { setAccessToken } from '../../../../lib/api-client.js';

/**
 * composer-attachment.test.tsx (P34 unit C, ADR 0052 accepted scope) - the
 * composer's single-attachment upload flow. Network is mocked at
 * `global.fetch` (never a running backend), same idiom as `composer.test.tsx`.
 * `URL.createObjectURL`/`revokeObjectURL` are stubbed - jsdom implements
 * neither, and `AttachmentPicker` calls them for the local image preview.
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '+919876543210';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderComposer(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <Composer />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function fillForm(): void {
  fireEvent.change(screen.getByTestId('compose-account-input'), {
    target: { value: INSTANCE_ID },
  });
  fireEvent.change(screen.getByTestId('compose-recipient-input'), {
    target: { value: RECIPIENT },
  });
}

function pickFile(file: File): void {
  const input = screen.getByTestId('attachment-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('Composer attachment', () => {
  beforeEach(() => {
    setAccessToken('test-token');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('an_over_cap_file_is_refused_client_side_with_no_upload_request', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();

    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    pickFile(oversized);

    await waitFor(() => {
      expect(screen.getByTestId('attachment-error').textContent).toContain('too large');
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/media'),
      expect.anything(),
    );
  });

  it('a_disallowed_mime_is_refused_client_side_with_no_upload_request', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();

    const badType = new File(['exe content'], 'app.exe', {
      type: 'application/x-msdownload',
    });
    pickFile(badType);

    await waitFor(() => {
      expect(screen.getByTestId('attachment-error').textContent).toContain('not supported');
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/media'),
      expect.anything(),
    );
  });

  it('a_successful_pick_uploads_once_and_send_carries_kind_and_mediaId_only', async () => {
    let mediaCallCount = 0;
    let sentBody: unknown = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      if (url.startsWith('/v1/media')) {
        mediaCallCount += 1;
        return Promise.resolve(
          jsonResponse(
            {
              data: {
                id: 'asset-1',
                kind: 'image',
                mimeType: 'image/png',
                sizeBytes: 1024,
                fileName: 'photo.png',
                createdAt: '2026-09-14T00:00:00.000Z',
              },
            },
            201,
          ),
        );
      }
      if (url.startsWith('/v1/messages')) {
        sentBody = init?.body ? JSON.parse(init.body as string) : null;
        return Promise.resolve(
          jsonResponse({ data: { id: 'job-public-id-3', status: 'queued' } }, 201),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();

    const goodFile = new File(['small'], 'photo.png', { type: 'image/png' });
    pickFile(goodFile);

    await waitFor(() => {
      expect(screen.getByTestId('attachment-chip')).not.toBeNull();
    });
    expect(mediaCallCount).toBe(1);

    fireEvent.change(screen.getByTestId('compose-body-input'), {
      target: { value: 'see attached' },
    });
    fireEvent.click(screen.getByTestId('compose-send-button'));

    await waitFor(() => {
      expect(sentBody).not.toBeNull();
    });

    expect(sentBody).toEqual({
      kind: 'image',
      recipient: RECIPIENT,
      payload: { mediaId: 'asset-1', caption: 'see attached' },
      priority: 'normal',
    });
    expect(sentBody).not.toHaveProperty('payload.fileName');
    expect(sentBody).not.toHaveProperty('payload.mimeType');
  });

  it('removing_the_attachment_returns_the_composer_to_plain_text_send', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      if (url.startsWith('/v1/media')) {
        return Promise.resolve(
          jsonResponse(
            {
              data: {
                id: 'asset-2',
                kind: 'document',
                mimeType: 'application/pdf',
                sizeBytes: 2048,
                fileName: 'invoice.pdf',
                createdAt: '2026-09-14T00:00:00.000Z',
              },
            },
            201,
          ),
        );
      }
      if (url.startsWith('/v1/messages')) {
        const body = init?.body ? (JSON.parse(init.body as string) as { kind: string }) : null;
        return Promise.resolve(
          jsonResponse({ data: { id: `job-${body?.kind ?? 'unknown'}`, status: 'queued' } }, 201),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();

    const doc = new File(['pdf bytes'], 'invoice.pdf', { type: 'application/pdf' });
    pickFile(doc);

    await waitFor(() => {
      expect(screen.getByTestId('attachment-chip')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('attachment-remove-button'));

    expect(screen.queryByTestId('attachment-chip')).toBeNull();

    fireEvent.change(screen.getByTestId('compose-body-input'), {
      target: { value: 'plain text message' },
    });
    fireEvent.click(screen.getByTestId('compose-send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('compose-status')).not.toBeNull();
    });
  });

  it('send_is_disabled_while_an_upload_is_in_flight', async () => {
    const uploadResolver: { current: (() => void) | null } = { current: null };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      if (url.startsWith('/v1/media')) {
        return new Promise<Response>((resolve) => {
          uploadResolver.current = () =>
            resolve(
              jsonResponse(
                {
                  data: {
                    id: 'asset-3',
                    kind: 'image',
                    mimeType: 'image/png',
                    sizeBytes: 1024,
                    fileName: 'photo.png',
                    createdAt: '2026-09-14T00:00:00.000Z',
                  },
                },
                201,
              ),
            );
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();
    fireEvent.change(screen.getByTestId('compose-body-input'), {
      target: { value: 'hello' },
    });

    const goodFile = new File(['small'], 'photo.png', { type: 'image/png' });
    pickFile(goodFile);

    await waitFor(() => {
      expect(screen.getByTestId('attachment-pending')).not.toBeNull();
    });
    expect((screen.getByTestId('compose-send-button') as HTMLButtonElement).disabled).toBe(true);

    uploadResolver.current?.();
    await waitFor(() => {
      expect(screen.getByTestId('attachment-chip')).not.toBeNull();
    });
    expect((screen.getByTestId('compose-send-button') as HTMLButtonElement).disabled).toBe(false);
  });
});
