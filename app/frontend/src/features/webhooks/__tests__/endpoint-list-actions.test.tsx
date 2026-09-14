// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import type { WebhookEndpointSummary } from '../api.js';

/**
 * endpoint-list-actions.test.tsx (P15 U6b, step 10) - proves the three
 * follow-up actions carried from U6: send-test-event, delete-with-confirm,
 * and re-enable (via `DisabledBanner`). API-layer mock only - never a raw
 * network call in a component test.
 *
 * `vi.mock` is keyed by an ABSOLUTE path specifier, not the relative
 * `'../api.js'` string: in the `jsdom` environment, this test file's own
 * `import.meta.url` is a Vite dev-server virtual URL
 * (`http://localhost:.../@fs/D:/...`), not a plain `file://` URL, so
 * resolving `'../api.ts'` against it does not land on the same module-graph
 * entry `components/endpoint-list.tsx` reaches via its relative
 * `'../api.js'` import - the mock factory then silently never applies and
 * the component falls through to the REAL `apiFetch`. `process.cwd()` (a
 * real filesystem path, `d:/kd/wp` on this checkout) is the stable base to
 * resolve the absolute specifier from instead.
 */
const { listMock, patchMock, deleteMock, testMock, apiModulePath } = vi.hoisted(() => {
  const cwd = process.cwd().replace(/\\/g, '/');
  return {
    listMock: vi.fn(),
    patchMock: vi.fn(),
    deleteMock: vi.fn(),
    testMock: vi.fn(),
    apiModulePath: `${cwd}/app/frontend/src/features/webhooks/api.ts`,
  };
});

vi.mock(apiModulePath, () => {
  return {
    listWebhookEndpoints: (...args: unknown[]) => listMock(...args),
    patchWebhookEndpoint: (...args: unknown[]) => patchMock(...args),
    deleteWebhookEndpoint: (...args: unknown[]) => deleteMock(...args),
    testWebhookEndpoint: (...args: unknown[]) => testMock(...args),
  };
});

const { EndpointList } = await import('../components/endpoint-list.js');

const ENABLED_ENDPOINT: WebhookEndpointSummary = {
  id: 'endpoint-1',
  url: 'https://example.com/webhooks/wp',
  events: ['message.job.status_changed'],
  enabled: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastSuccessAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
};

const DISABLED_ENDPOINT: WebhookEndpointSummary = {
  ...ENABLED_ENDPOINT,
  id: 'endpoint-2',
  enabled: false,
  disabledReason: 'consecutive_failures',
};

function renderList(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <EndpointList />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('EndpointList actions', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('send_test_event_calls_the_test_route_and_shows_success', async () => {
    listMock.mockResolvedValue([ENABLED_ENDPOINT]);
    testMock.mockResolvedValue({ deliveryId: 'delivery-1', status: 'pending' });

    renderList();

    const testButton = await screen.findByTestId('webhook-test-button-endpoint-1');
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(testMock).toHaveBeenCalledWith('endpoint-1');
    });

    const result = await screen.findByTestId('webhook-test-result-endpoint-1');
    expect(result.textContent).toMatch(/queued/i);
  });

  it('send_test_event_surfaces_an_error_state_on_failure', async () => {
    listMock.mockResolvedValue([ENABLED_ENDPOINT]);
    testMock.mockRejectedValue(new Error('boom'));

    renderList();

    const testButton = await screen.findByTestId('webhook-test-button-endpoint-1');
    fireEvent.click(testButton);

    const result = await screen.findByTestId('webhook-test-result-endpoint-1');
    expect(result.getAttribute('role')).toBe('alert');
    expect(result.textContent).toMatch(/could not/i);
  });

  it('delete_requires_confirmation_before_calling_the_delete_route', async () => {
    listMock.mockResolvedValue([ENABLED_ENDPOINT]);
    deleteMock.mockResolvedValue({ id: 'endpoint-1' });

    renderList();

    const deleteButton = await screen.findByTestId('webhook-delete-button-endpoint-1');
    fireEvent.click(deleteButton);

    // No call yet - only the inline confirm step is shown.
    expect(deleteMock).not.toHaveBeenCalled();
    const confirmButton = await screen.findByTestId('webhook-delete-confirm-button-endpoint-1');

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('endpoint-1');
    });
  });

  it('delete_cancel_never_calls_the_delete_route', async () => {
    listMock.mockResolvedValue([ENABLED_ENDPOINT]);

    renderList();

    const deleteButton = await screen.findByTestId('webhook-delete-button-endpoint-1');
    fireEvent.click(deleteButton);

    const cancelButton = await screen.findByTestId('webhook-delete-cancel-button-endpoint-1');
    fireEvent.click(cancelButton);

    expect(screen.queryByTestId('webhook-delete-confirm-endpoint-1')).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('re_enable_issues_a_patch_with_enabled_true_only', async () => {
    listMock.mockResolvedValue([DISABLED_ENDPOINT]);
    patchMock.mockResolvedValue({ ...DISABLED_ENDPOINT, enabled: true, disabledReason: null });

    renderList();

    const reEnableButton = await screen.findByTestId('webhook-reenable-button');
    fireEvent.click(reEnableButton);

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('endpoint-2', { enabled: true });
    });
  });
});
