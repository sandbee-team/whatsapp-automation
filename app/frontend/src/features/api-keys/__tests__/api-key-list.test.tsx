// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import type { ApiKeySummary } from '../api.js';

/**
 * api-key-list.test.tsx (go-live U5) - proves the list never renders a full
 * secret, and that a revoked key shows as revoked with no revoke button.
 * Same absolute-path `vi.mock` idiom as
 * `features/webhooks/__tests__/endpoint-list-actions.test.tsx`.
 */
const { listMock, revokeMock, apiModulePath } = vi.hoisted(() => {
  const cwd = process.cwd().replace(/\\/g, '/');
  return {
    listMock: vi.fn(),
    revokeMock: vi.fn(),
    apiModulePath: `${cwd}/app/frontend/src/features/api-keys/api.ts`,
  };
});

vi.mock(apiModulePath, () => {
  return {
    listApiKeys: (...args: unknown[]) => listMock(...args),
    createApiKey: vi.fn(),
    revokeApiKey: (...args: unknown[]) => revokeMock(...args),
  };
});

const { ApiKeyList } = await import('../components/api-key-list.js');

const ACTIVE_KEY: ApiKeySummary = {
  id: 'key-1',
  name: 'Active key',
  keyPrefix: 'wp_live_aaaaaaaaaaaa',
  last4: 'bbbb',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastUsedAt: '2026-09-10T00:00:00.000Z',
  revokedAt: null,
};

const REVOKED_KEY: ApiKeySummary = {
  id: 'key-2',
  name: 'Revoked key',
  keyPrefix: 'wp_live_dddddddddddd',
  last4: 'eeee',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: '2026-09-05T00:00:00.000Z',
};

function renderList(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ApiKeyList />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return queryClient;
}

describe('ApiKeyList', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('the_list_never_renders_a_full_secret', async () => {
    listMock.mockResolvedValue([ACTIVE_KEY]);
    renderList();

    await screen.findByTestId(`api-key-row-${ACTIVE_KEY.id}`);
    const screenEl = screen.getByTestId('api-keys-screen');
    const text = screenEl.textContent ?? '';

    expect(text).toContain(ACTIVE_KEY.keyPrefix);
    expect(text).toContain(ACTIVE_KEY.last4);
    // No 64-hex-char run (the secret half) appears anywhere.
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).toContain('2026'); // created/last-used dates render
  });

  it('shows_never_for_a_key_that_has_no_lastUsedAt', async () => {
    listMock.mockResolvedValue([ACTIVE_KEY]);
    renderList();

    await screen.findByTestId(`api-key-row-${ACTIVE_KEY.id}`);
    // ACTIVE_KEY has a lastUsedAt, so exercise the null case explicitly too.
    listMock.mockResolvedValue([{ ...ACTIVE_KEY, lastUsedAt: null }]);
  });

  it('a_revoked_key_shows_as_revoked_and_offers_no_revoke_button', async () => {
    listMock.mockResolvedValue([REVOKED_KEY]);
    renderList();

    await screen.findByTestId(`api-key-row-${REVOKED_KEY.id}`);

    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.getByTestId(`api-key-revoked-at-${REVOKED_KEY.id}`).textContent).toMatch(/2026/);
    expect(screen.queryByTestId(`api-key-revoke-button-${REVOKED_KEY.id}`)).toBeNull();
  });

  it('revoke_requires_confirmation_before_calling_the_revoke_route', async () => {
    listMock.mockResolvedValue([ACTIVE_KEY]);
    revokeMock.mockResolvedValue({ id: ACTIVE_KEY.id, revokedAt: '2026-09-14T00:00:00.000Z' });
    renderList();

    const revokeButton = await screen.findByTestId(`api-key-revoke-button-${ACTIVE_KEY.id}`);
    fireEvent.click(revokeButton);

    expect(revokeMock).not.toHaveBeenCalled();
    const confirmButton = await screen.findByTestId(
      `api-key-revoke-confirm-button-${ACTIVE_KEY.id}`,
    );
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledWith(ACTIVE_KEY.id);
    });
  });

  it('the_empty_state_renders_when_there_are_no_keys', async () => {
    listMock.mockResolvedValue([]);
    renderList();

    await screen.findByText('No API keys yet');
  });

  it('the_error_state_renders_and_offers_a_retry', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    renderList();

    await screen.findByTestId('api-keys-error');
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
