// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import type { ApiKeySummary } from '../api.js';

/**
 * key-once-dialog.test.tsx (go-live U5) - proves the one-time key reveal:
 * the raw key is shown once and is gone from BOTH the DOM and the
 * react-query cache after dismiss. Same absolute-path `vi.mock` idiom as
 * `features/webhooks/__tests__/endpoint-list-actions.test.tsx` (the
 * relative specifier does not resolve to the same module-graph entry the
 * component reaches under jsdom's virtual `import.meta.url`).
 */
const { listMock, createMock, apiModulePath } = vi.hoisted(() => {
  const cwd = process.cwd().replace(/\\/g, '/');
  return {
    listMock: vi.fn(),
    createMock: vi.fn(),
    apiModulePath: `${cwd}/app/frontend/src/features/api-keys/api.ts`,
  };
});

vi.mock(apiModulePath, () => {
  return {
    listApiKeys: (...args: unknown[]) => listMock(...args),
    createApiKey: (...args: unknown[]) => createMock(...args),
    revokeApiKey: vi.fn(),
  };
});

const { ApiKeyList } = await import('../components/api-key-list.js');

const EXISTING_KEY: ApiKeySummary = {
  id: 'key-1',
  name: 'Existing key',
  keyPrefix: 'wp_live_aaaaaaaaaaaa',
  last4: 'bbbb',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

const RAW_SECRET_SUFFIX = 'c'.repeat(64);
const RAW_KEY = `wp_live_aaaaaaaaaaaa_${RAW_SECRET_SUFFIX}`;

function renderList(queryClient: QueryClient): void {
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ApiKeyList />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('KeyOnceDialog (via ApiKeyList)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('the_raw_key_is_shown_once_and_is_gone_after_dismiss', async () => {
    listMock.mockResolvedValue([EXISTING_KEY]);
    createMock.mockResolvedValue({
      id: 'key-2',
      name: 'New key',
      keyPrefix: 'wp_live_aaaaaaaaaaaa',
      last4: 'ffff',
      createdAt: '2026-09-14T00:00:00.000Z',
      key: RAW_KEY,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderList(queryClient);

    await screen.findByTestId(`api-key-row-${EXISTING_KEY.id}`);

    fireEvent.click(screen.getByTestId('api-keys-add-button'));
    fireEvent.change(screen.getByTestId('api-key-name-input'), {
      target: { value: 'New key' },
    });
    fireEvent.click(screen.getByTestId('api-key-form-submit'));

    const secretNode = await screen.findByTestId('api-key-value');
    expect(secretNode.textContent).toBe(RAW_KEY);

    fireEvent.click(screen.getByTestId('api-key-done'));

    await waitFor(() => {
      expect(screen.queryByTestId('api-key-value')).toBeNull();
    });

    // Gone from the DOM entirely - no residual node anywhere carries it.
    expect(document.body.textContent ?? '').not.toContain(RAW_KEY);

    // Gone from the query cache: `list` never held it (its schema never
    // carries `key`), and no other cache entry does either.
    const cachedData = queryClient
      .getQueryCache()
      .getAll()
      .flatMap((entry) => {
        const value = entry.state.data;
        return value === undefined ? [] : [JSON.stringify(value)];
      });
    for (const cached of cachedData) {
      expect(cached).not.toContain(RAW_KEY);
    }
  });
});
