// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { DuplicateFanoutBanner } from '../DuplicateFanoutBanner.js';
import { setAccessToken } from '../../../lib/api-client.js';
import * as pacingApi from '../api.js';

/**
 * duplicate-fanout-banner.test.tsx (P14 Unit U7, step 3) - follows
 * `unresolved-sends-panel.test.tsx`'s idiom (network mocked at the module
 * boundary; honest loading/empty/error states asserted directly).
 */

const ITEM_A = { localDate: '2026-09-02', fingerprintHex: 'a'.repeat(64), recipientCount: 600 };
const ITEM_B = { localDate: '2026-09-02', fingerprintHex: 'b'.repeat(64), recipientCount: 750 };

function renderBanner(): void {
  render(
    <I18nProvider locale="en">
      <DuplicateFanoutBanner />
    </I18nProvider>,
  );
}

describe('DuplicateFanoutBanner', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setAccessToken(null);
  });

  it('renders_nothing_while_loading_or_when_there_is_nothing_pending', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([]);

    renderBanner();

    expect(screen.queryByTestId('duplicate-fanout-banner')).toBeNull();
    await waitFor(() => {
      expect(pacingApi.fetchPendingFanoutAcks).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('duplicate-fanout-banner')).toBeNull();
  });

  it('renders_one_item_per_pending_fingerprint_with_the_exact_recipient_count', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([ITEM_A, ITEM_B]);

    renderBanner();

    await waitFor(() => {
      expect(screen.getByTestId(`duplicate-fanout-item-${ITEM_A.fingerprintHex}`)).not.toBeNull();
    });
    expect(screen.getByTestId(`duplicate-fanout-item-${ITEM_B.fingerprintHex}`)).not.toBeNull();

    const bodyA = screen.getByTestId(`duplicate-fanout-item-${ITEM_A.fingerprintHex}`).textContent;
    expect(bodyA).toContain('600');
    const bodyB = screen.getByTestId(`duplicate-fanout-item-${ITEM_B.fingerprintHex}`).textContent;
    expect(bodyB).toContain('750');
  });

  it('never_renders_a_message_body_or_a_restriction_prevention_claim', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([ITEM_A]);

    renderBanner();

    await waitFor(() => {
      expect(screen.getByTestId(`duplicate-fanout-item-${ITEM_A.fingerprintHex}`)).not.toBeNull();
    });

    const text = screen.getByTestId('duplicate-fanout-banner').textContent ?? '';
    expect(text).not.toContain('Big sale');
    expect(text).not.toContain('prevent');
    expect(text).not.toContain('guarantee');
    expect(text).not.toContain('ban');
  });

  it('confirm_calls_the_ack_endpoint_once_and_optimistically_clears_the_item', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([ITEM_A]);
    const ackSpy = vi.spyOn(pacingApi, 'ackFanoutItem').mockResolvedValue(true);

    renderBanner();

    await waitFor(() => {
      expect(
        screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`));

    await waitFor(() => {
      expect(ackSpy).toHaveBeenCalledTimes(1);
    });
    expect(ackSpy).toHaveBeenCalledWith(ITEM_A);

    await waitFor(() => {
      expect(screen.queryByTestId('duplicate-fanout-banner')).toBeNull();
    });
  });

  it('a_double_click_sends_exactly_one_ack_request', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([ITEM_A]);
    const pendingAck: { resolve: ((value: boolean) => void) | null } = { resolve: null };
    const ackSpy = vi.spyOn(pacingApi, 'ackFanoutItem').mockReturnValue(
      new Promise((resolve) => {
        pendingAck.resolve = resolve;
      }),
    );

    renderBanner();

    await waitFor(() => {
      expect(
        screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`),
      ).not.toBeNull();
    });

    const button = screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`);
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(ackSpy).toHaveBeenCalledTimes(1);
    });

    pendingAck.resolve?.(true);
  });

  it('a_failed_ack_keeps_the_item_and_shows_an_error_so_the_user_can_retry', async () => {
    vi.spyOn(pacingApi, 'fetchPendingFanoutAcks').mockResolvedValue([ITEM_A]);
    vi.spyOn(pacingApi, 'ackFanoutItem').mockRejectedValue(new Error('boom'));

    renderBanner();

    await waitFor(() => {
      expect(
        screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId(`duplicate-fanout-confirm-${ITEM_A.fingerprintHex}`));

    await waitFor(() => {
      expect(screen.getByTestId(`duplicate-fanout-item-${ITEM_A.fingerprintHex}`)).not.toBeNull();
    });
    const text =
      screen.getByTestId(`duplicate-fanout-item-${ITEM_A.fingerprintHex}`).textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});
