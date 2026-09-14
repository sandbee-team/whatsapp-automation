// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { QrPanel } from '../QrPanel.js';

/**
 * qr-panel.test.tsx (P08 U7) - proves the 45s countdown ring/attempts-left
 * label track an injected `now()` (fake-timer friendly, never a bare
 * `Date.now()`), and that the EXPIRED state renders ONLY a "Generate a new
 * code" button - no timer of any kind ever calls `onRefresh` by itself
 * (`connect_expired_state_shows_button_never_auto_retries`).
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
});
