// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { BROADCAST_DISCLOSURE } from '@wp/domain';
import type { BroadcastDetail } from '../api.js';
import { Funnel } from '../components/funnel.js';

/**
 * funnel.test.tsx (P23a Unit U5) - proves `Funnel` derives its stage rows
 * purely from the partition counters (never a re-fetch of its own), renders
 * the honest lower-bound receipts caveat, and formats `chargedMinor` via the
 * same integer-paise discipline as `PreflightPanel`.
 */

function buildDetail(
  counters: BroadcastDetail['counters'],
  disclosure: BroadcastDetail['disclosure'],
): BroadcastDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Launch',
    status: 'running',
    instanceId: '22222222-2222-4222-8222-222222222222',
    priority: 'low',
    audienceCount: counters.total,
    quoteMinor: counters.chargedMinor,
    priceKey: 'default',
    scheduledAt: null,
    snapshotDoneAt: '2026-09-06T00:00:00.000Z',
    expandDoneAt: '2026-09-06T00:00:00.000Z',
    cancelReason: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    counters,
    disclosure,
  };
}

function renderFunnel(locale: Locale, detail: BroadcastDetail): void {
  render(
    <I18nProvider locale={locale}>
      <Funnel detail={detail} />
    </I18nProvider>,
  );
}

describe('Funnel', () => {
  afterEach(() => {
    cleanup();
  });

  it('funnel_stages_are_derived_from_the_partition_counters', () => {
    const counters: BroadcastDetail['counters'] = {
      total: 100,
      pending: 5,
      skipped: 3,
      queued: 12,
      sent: 40,
      delivered: 25,
      read: 10,
      failed: 3,
      cancelled: 2,
      deferred: 4,
      chargedMinor: 1125,
    };
    const detail = buildDetail(counters, BROADCAST_DISCLOSURE);
    renderFunnel('en', detail);

    expect(screen.getByTestId('funnel-total').textContent).toContain('100');
    const queuedRow = screen.getByTestId('funnel-queued');
    expect(queuedRow.textContent).toContain('17');
    expect(queuedRow.textContent).toContain('4');
    expect(queuedRow.textContent).toContain('waiting for pacing');
    expect(screen.getByTestId('funnel-sent').textContent).toContain('75');
    expect(screen.getByTestId('funnel-delivered').textContent).toContain('35');
    expect(screen.getByTestId('funnel-read').textContent).toContain('10');
    expect(screen.getByTestId('funnel-skipped').textContent).toContain('3');
    expect(screen.getByTestId('funnel-failed').textContent).toContain('3');
    expect(screen.getByTestId('funnel-cancelled').textContent).toContain('2');

    const panelText = document.body.textContent ?? '';
    expect(panelText).toContain('₹11.25');
  });

  it.each<Locale>(['en', 'hi'])(
    'funnel_says_receipts_are_a_lower_bound_in_both_locales (%s)',
    (locale) => {
      const counters: BroadcastDetail['counters'] = {
        total: 10,
        pending: 0,
        skipped: 0,
        queued: 0,
        sent: 10,
        delivered: 5,
        read: 1,
        failed: 0,
        cancelled: 0,
        deferred: 0,
        chargedMinor: 300,
      };
      const detail = buildDetail(counters, BROADCAST_DISCLOSURE);
      renderFunnel(locale, detail);

      const expected =
        locale === 'en'
          ? 'Delivered and read counts are a lower bound: WhatsApp does not guarantee that every receipt reaches a linked device.'
          : 'डिलीवर और पढ़े गए की संख्या न्यूनतम आंकड़ा है: WhatsApp यह गारंटी नहीं देता कि हर रसीद किसी लिंक किए गए डिवाइस तक पहुंचे।';
      expect(screen.getByTestId('funnel-receipts-caveat').textContent).toBe(expected);
    },
  );
});
