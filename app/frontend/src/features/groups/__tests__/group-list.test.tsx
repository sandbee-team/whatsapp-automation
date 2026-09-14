// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider, type Locale } from '@wp/ui';
import { GROUP_RISK_DISCLOSURE } from '@wp/domain';
import { en } from '@wp/i18n';
import { GroupList } from '../components/group-list.js';
import {
  stubGroupsFetch,
  groupFixture,
  GROUP_ID,
  INSTANCE_ID,
  type RecordedRequest,
} from '../__test-support__/stub-groups-fetch.js';

/**
 * group-list.test.tsx (P24 groups-messaging, Unit U5; P26b C1 fix round) -
 * the groups panel's risk-disclosure surfacing, device-budget refusal copy,
 * cap-zero honesty, sync rate-limiting, Leave availability across every
 * band, and the no-JID data-minimisation guarantee. The per-(group, action)
 * Idempotency-Key retry-reuse contract plus failure toasts live in the
 * sibling `group-list-mutation-failures.test.tsx` (`max-lines: 300` split).
 * Same `renderWithClient` + raw fetch stub idiom as `broadcast-list.test.tsx`
 * - no MSW. `ToastProvider` wraps every render here (and in
 * `groups-screen.test.tsx`) because `GroupList` now calls `useToast()`
 * unconditionally.
 */

function renderWithProviders(locale: Locale = 'en'): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale={locale}>
      <ToastProvider dismissLabel="Dismiss">
        <QueryClientProvider client={queryClient}>
          <GroupList instanceId={INSTANCE_ID} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
  return queryClient;
}

function renderList(locale: Locale = 'en'): {
  requests: RecordedRequest[];
  queryClient: QueryClient;
} {
  const requests: RecordedRequest[] = [];
  stubGroupsFetch(requests);
  const queryClient = renderWithProviders(locale);
  return { requests, queryClient };
}

describe('GroupList', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each<Locale>(['en', 'hi'])(
    'the_group_enable_dialog_states_the_report_risk_verbatim (%s)',
    async (locale) => {
      renderList(locale);

      const headerDisclosures = await screen.findAllByTestId('group-header-disclosure');
      expect(headerDisclosures[0]!.textContent).toBe(GROUP_RISK_DISCLOSURE);

      const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
      fireEvent.click(toggle);

      const dialog = await screen.findByTestId('enable-send-dialog');
      const dialogDisclosures = within(dialog).getAllByTestId('group-header-disclosure');
      expect(dialogDisclosures[0]!.textContent).toBe(GROUP_RISK_DISCLOSURE);

      const reachLine = within(dialog).getByTestId('enable-reach-line');
      expect(reachLine.textContent ?? '').toContain('250');
    },
  );

  it('a_device_budget_refusal_names_the_current_total', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, {
      failNextEnableWith: {
        reason: 'DEVICE_BUDGET_EXCEEDED',
        trackedDevicesEnabledTotal: 1990,
        max: 2000,
      },
    });
    renderWithProviders();

    const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
    fireEvent.click(toggle);

    const dialog = await screen.findByTestId('enable-send-dialog');
    const confirmButton = within(dialog).getByRole('button', { name: 'Turn on' });
    fireEvent.click(confirmButton);

    const alert = await waitFor(() => within(dialog).getByRole('alert'));
    expect(alert.textContent ?? '').toContain('1990');
    expect(alert.textContent ?? '').toContain('2000');

    // The toggle stays off - no send-enabled success ever landed.
    expect(screen.getByTestId('enable-send-dialog')).toBeTruthy();
    const toggleAfter = screen.getByTestId(`group-row-toggle-${GROUP_ID}`);
    expect(toggleAfter.getAttribute('aria-checked')).toBe('false');
  });

  it('cap_zero_renders_off_at_tier_not_zero_of_zero', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { effGroupDailyCap: 0, sentToday: 0, remainingToday: 0 });
    renderWithProviders();

    const chip = await screen.findByTestId('group-cap-chip');
    expect(chip.textContent ?? '').toContain(en['groups.cap.offAtTier']);
    expect(chip.textContent ?? '').not.toContain('0 of 0');
    expect(chip.textContent ?? '').not.toMatch(/0\s*\/\s*0/);
  });

  it('sync_inside_the_hour_is_shown_as_rate_limited', async () => {
    const futureTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { nextSyncAfter: futureTime });
    renderWithProviders();

    const syncButton = await screen.findByTestId('groups-sync-button');
    await waitFor(() => expect((syncButton as HTMLButtonElement).disabled).toBe(true));
    await screen.findByTestId('groups-sync-rate-limited');
  });

  it('sync_inside_the_hour_is_shown_as_rate_limited_on_a_429_response', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { failNextSyncWithRateLimit: true });
    renderWithProviders();

    const syncButton = await screen.findByTestId('groups-sync-button');
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect((screen.getByTestId('groups-sync-button') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it.each([
    ['healthy', 1],
    ['watch', 2],
    ['degraded', 4],
    ['critical', 6],
  ] as const)('leave_is_available_in_every_band (%s tier %s)', async (healthBand, warmupTier) => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { healthBand, warmupTier });
    renderWithProviders();

    const leaveButton = await screen.findByTestId(`group-row-leave-${GROUP_ID}`);
    expect(leaveButton).toBeTruthy();
  });

  it('no_group_jid_is_ever_rendered', async () => {
    renderList();
    await screen.findByTestId(`group-row-${GROUP_ID}`);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('@g.us');
  });

  it('leave_is_hidden_once_leave_was_requested_and_shows_the_leave_requested_reason', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, {
      groups: [
        groupFixture(GROUP_ID, {
          leaveRequestedAt: '2026-09-05T00:00:00.000Z',
          disabledReason: 'leave_requested',
        }),
      ],
    });
    renderWithProviders();

    await screen.findByTestId(`group-row-${GROUP_ID}`);
    expect(screen.queryByTestId(`group-row-leave-${GROUP_ID}`)).toBeNull();
    expect(screen.getByTestId(`group-row-reason-${GROUP_ID}`).textContent).toBe(
      'Leaving this group.',
    );
  });
});

describe('GroupList loading/empty/error states', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a_list_fetch_error_shows_an_honest_error_state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network down'))),
    );
    renderWithProviders();
    await screen.findByTestId('groups-error');
  });

  it('an_empty_group_list_shows_the_honest_empty_state', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { groups: [] });
    renderWithProviders();
    await screen.findByText('No groups synced yet for this number.');
  });
});
