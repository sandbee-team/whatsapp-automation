// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { InstanceCard } from '../components/instance-card.js';
import type { InstanceCardResult } from '../api.js';

/**
 * instance-card.test.tsx (P17 U5) - proves the countdown ticks client-side
 * from `nextSendEarliestAt` with server-time skew correction while sending,
 * and that it renders the "not sending" floor string with ZERO scheduled
 * timers whenever the instance is paused/parked
 * (`the_countdown_stops_and_reads_not_sending_when_paused`) - same
 * no-silent-timer idiom as `QrPanel.tsx`'s expired-state test.
 */

const BASE_CARD: InstanceCardResult = {
  instanceId: '11111111-1111-1111-1111-111111111111',
  label: 'Sales team',
  linkState: 'linked',
  healthState: 'connected',
  desiredState: 'online',
  parked: false,
  needsUserAction: false,
  userActionReason: null,
  healthScore: 90,
  healthBand: 'HEALTHY',
  warmupTier: 2,
  warmupDay: 5,
  todaySent: 10,
  effDailyCap: 100,
  newConversationsToday: 2,
  effNewConvCap: 20,
  sendingWindow: { start: '09:00', end: '20:00', tz: 'Asia/Kolkata' },
  lastSendAt: '2026-01-01T00:00:00.000Z',
  queueDepth: 5,
  queueDepthCapped: false,
  oldestQueuedAgeSeconds: 30,
  nextSendEarliestAt: new Date('2026-01-01T00:00:45.000Z').toISOString(),
  serverNow: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};

function renderCard(
  overrides: Partial<InstanceCardResult>,
  props: {
    now?: () => number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
  locale: Locale = 'en',
): void {
  render(
    <I18nProvider locale={locale}>
      <InstanceCard
        data={{ ...BASE_CARD, ...overrides }}
        onOpenWhyDrawer={() => {}}
        now={props.now}
        setIntervalFn={props.setIntervalFn}
        clearIntervalFn={props.clearIntervalFn}
      />
    </I18nProvider>,
  );
}

describe('InstanceCard', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each<Locale>(['en', 'hi'])(
    'the_countdown_stops_and_reads_not_sending_when_paused (%s)',
    async (locale) => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.fn(setInterval);
      const clearIntervalSpy = vi.fn(clearInterval);

      renderCard(
        { parked: true },
        {
          now: () => new Date('2026-01-01T00:00:00.000Z').getTime(),
          setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
          clearIntervalFn: clearIntervalSpy as unknown as typeof clearInterval,
        },
        locale,
      );

      // The not-sending state renders immediately - no countdown node at all.
      expect(screen.getByTestId('instance-card-not-sending')).not.toBeNull();
      expect(screen.queryByTestId('instance-card-next-send')).toBeNull();

      // Hard safety assertion: NO timer was ever scheduled while paused/
      // parked - not merely "not visible", genuinely never scheduled.
      expect(setIntervalSpy).not.toHaveBeenCalled();

      // Advancing a large amount of fake time changes nothing and schedules
      // nothing retroactively either.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId('instance-card-not-sending')).not.toBeNull();
    },
  );

  it('counts_down_from_next_send_earliest_at_with_server_skew_correction', async () => {
    vi.useFakeTimers();
    // Server clock is 5s AHEAD of the browser clock (skew = +5000ms).
    let currentTime = new Date('2026-01-01T00:00:00.000Z').getTime();
    const serverNow = new Date('2026-01-01T00:00:05.000Z').toISOString();

    renderCard(
      { nextSendEarliestAt: new Date('2026-01-01T00:00:45.000Z').toISOString(), serverNow },
      { now: () => currentTime },
    );

    // remaining = nextSendEarliestAt(45s) + skew(+5s) - now(0s) = 50s.
    const before = screen.getByTestId('instance-card-next-send').textContent ?? '';
    expect(before).toContain('50');

    currentTime = new Date('2026-01-01T00:00:10.000Z').getTime();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // remaining = 45 + 5 - 10 = 40s.
    const after = screen.getByTestId('instance-card-next-send').textContent ?? '';
    expect(after).toContain('40');
  });

  it('renders_not_sending_when_next_send_earliest_at_is_null', () => {
    renderCard({ nextSendEarliestAt: null });
    expect(screen.getByTestId('instance-card-not-sending')).not.toBeNull();
    expect(screen.queryByTestId('instance-card-next-send')).toBeNull();
  });

  it('renders the today and new-conversations progress bars with exact aria-valuenow/max', () => {
    renderCard({ todaySent: 25, effDailyCap: 100, newConversationsToday: 3, effNewConvCap: 20 });

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('aria-valuenow')).toBe('25');
    expect(bars[0]?.getAttribute('aria-valuemax')).toBe('100');
    expect(bars[1]?.getAttribute('aria-valuenow')).toBe('3');
    expect(bars[1]?.getAttribute('aria-valuemax')).toBe('20');
  });

  it('pulses the state dot only when connected, not when degraded', () => {
    renderCard({ healthState: 'connected' });
    const connectedDot = screen.getByTestId('instance-card-state-dot');
    expect(connectedDot.className).toContain('animate-pulse');

    cleanup();
    renderCard({ healthState: 'degraded' });
    const degradedDot = screen.getByTestId('instance-card-state-dot');
    expect(degradedDot.className).not.toContain('animate-pulse');
  });
});
