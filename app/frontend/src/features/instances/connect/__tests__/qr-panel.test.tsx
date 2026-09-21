// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { QrPanel } from '../QrPanel.js';

/**
 * qr-panel.test.tsx (P08 U7; 90s window 2026-09-17) - proves the countdown
 * ring/attempts-left label track an injected `now()` (fake-timer friendly,
 * never a bare `Date.now()`), that the EXPIRED state renders ONLY a
 * "Generate a new code" button - no timer of any kind ever calls `onRefresh`
 * by itself (`connect_expired_state_shows_button_never_auto_retries`) - and
 * that the ring's fill fraction tracks the real 90s reference window, not
 * the old 45s one (`a_fresh_90s_qr_ring_is_half_drained_at_the_45s_midpoint_
 * not_still_full`). The first two tests below use a 45s `expiresAt` fixture
 * deliberately - `qr-seconds-left`/expiry are driven purely by `expiresAt`
 * vs `now`, independent of `totalWindowMs`, so a 45s fixture remains a valid
 * (if shorter-than-production-default) countdown to exercise.
 */

function renderQrPanel(
  props: Partial<React.ComponentProps<typeof QrPanel>>,
  locale: Locale = 'en',
): { onRefresh: ReturnType<typeof vi.fn> } {
  const onRefresh = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <QrPanel
        payload="qr-payload-string"
        expiresAt={new Date('2026-01-01T00:00:45.000Z').toISOString()}
        attemptsLeft={3}
        onRefresh={onRefresh}
        now={() => new Date('2026-01-01T00:00:00.000Z').getTime()}
        {...props}
      />
    </I18nProvider>,
  );
  return { onRefresh };
}

describe('QrPanel', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('connect_expired_state_shows_button_never_auto_retries', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-01-01T00:00:45.000Z').toISOString();
    let currentTime = new Date('2026-01-01T00:00:00.000Z').getTime();

    const { onRefresh } = renderQrPanel({
      expiresAt,
      now: () => currentTime,
    });

    // Not yet expired: no expired panel, no refresh button.
    expect(screen.queryByTestId('qr-expired')).toBeNull();

    // Advance real elapsed time past the 45s window AND move the injected
    // clock past `expiresAt` together, driving the component's internal
    // tick.
    currentTime = new Date('2026-01-01T00:00:46.000Z').getTime();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const expiredPanel = screen.getByTestId('qr-expired');
    expect(expiredPanel).not.toBeNull();
    const refreshButton = screen.getByTestId('qr-refresh-button');
    expect(refreshButton).not.toBeNull();

    // The core safety assertion: letting a large amount of fake time pass
    // with ZERO pending timers ever firing `onRefresh` on its own - only an
    // explicit click may call it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onRefresh).not.toHaveBeenCalled();

    fireEvent.click(refreshButton);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('qr_panel_counts_down_and_shows_attempts_left', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-01-01T00:00:45.000Z').toISOString();
    let currentTime = new Date('2026-01-01T00:00:00.000Z').getTime();

    renderQrPanel({
      expiresAt,
      attemptsLeft: 2,
      now: () => currentTime,
    });

    const attemptsBadge = screen.getByTestId('qr-attempts-left');
    expect(attemptsBadge.textContent).toContain('2');

    const secondsLabelBefore = screen.getByTestId('qr-seconds-left').textContent;
    expect(secondsLabelBefore).toBe('45');

    currentTime = new Date('2026-01-01T00:00:20.000Z').getTime();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const secondsLabelAfter = screen.getByTestId('qr-seconds-left').textContent;
    expect(secondsLabelAfter).toBe('25');
    expect(Number(secondsLabelAfter)).toBeLessThan(Number(secondsLabelBefore));
  });

  /**
   * Regression test for the 90s-window fix (2026-09-17): `totalWindowMs`
   * (the ring's "how full does this look" reference span) must track
   * `pairing.ts`'s real 90_000 default. Before this fix it was still
   * hardcoded at 45_000, so a fresh 90s-window QR (remainingMs=90_000)
   * computed `fraction = min(1, 90000/45000) = 1` for its entire first 45
   * seconds - the ring rendered stuck at "full" and only started visibly
   * draining halfway through the real window, which would read to an
   * operator as "the countdown isn't moving".
   */
  it('a_fresh_90s_qr_ring_is_half_drained_at_the_45s_midpoint_not_still_full', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date('2026-01-01T00:01:30.000Z').toISOString(); // now + 90s
    let currentTime = new Date('2026-01-01T00:00:00.000Z').getTime();

    renderQrPanel({ expiresAt, now: () => currentTime });

    const ringAt0s = screen
      .getByTestId('qr-countdown-ring')
      .querySelectorAll('circle')[1]!.getAttribute('stroke-dashoffset');
    // Full window remaining -> the progress circle is fully drawn (offset 0).
    expect(Number(ringAt0s)).toBeCloseTo(0, 1);

    currentTime = new Date('2026-01-01T00:00:45.000Z').getTime(); // the old 45s TTL's full duration
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    const circumference = 2 * Math.PI * 20;
    const ringAt45s = Number(
      screen
        .getByTestId('qr-countdown-ring')
        .querySelectorAll('circle')[1]!.getAttribute('stroke-dashoffset'),
    );
    // Exactly half the 90s window has elapsed - the ring must be half-drained
    // (offset ~= half the circumference), never still at/near 0 (which the
    // pre-fix 45_000 reference span would have produced).
    expect(ringAt45s).toBeCloseTo(circumference / 2, 0);
  });
});
