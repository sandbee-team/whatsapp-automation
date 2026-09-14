import { describe, expect, it } from 'vitest';
import {
  deriveFleetHealth,
  deriveHasSentMessage,
  deriveHasWalletFunds,
  deriveKpiHints,
  deriveOutcomeSegments,
} from './dashboard-derive.js';
import type { InstanceListItem } from '../instances/use-instance-list.js';

/**
 * dashboard-derive.test.ts (2026-09-08 panel refresh, unit S2) - exact-value
 * unit tests for the dashboard's pure derivations, kept separate from
 * `dashboard-page.test.tsx` so the arithmetic is proven without rendering the
 * whole page (test-discipline: narrowest file first).
 */

function item(overrides: {
  instanceId: string;
  healthScore: number | null;
  healthBand: 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';
}): InstanceListItem {
  return {
    instanceId: overrides.instanceId,
    queue: {
      instanceId: overrides.instanceId,
      waiting: 0,
      sentToday: 0,
      failedToday: 0,
      spentTodayMinor: '0',
    },
    card: {
      instanceId: overrides.instanceId,
      label: 'x',
      linkState: 'linked',
      healthState: 'connected',
      desiredState: 'online',
      parked: false,
      needsUserAction: false,
      userActionReason: null,
      healthScore: overrides.healthScore,
      healthBand: overrides.healthBand,
      warmupTier: 1,
      warmupDay: 1,
      todaySent: 0,
      effDailyCap: 10,
      newConversationsToday: 0,
      effNewConvCap: 5,
      sendingWindow: { start: '09:00', end: '20:00', tz: 'Asia/Kolkata' },
      lastSendAt: null,
      queueDepth: 0,
      queueDepthCapped: false,
      oldestQueuedAgeSeconds: null,
      nextSendEarliestAt: null,
      serverNow: '2026-01-01T00:00:00.000Z',
    },
    cardStatus: 'success',
  };
}

describe('deriveHasSentMessage', () => {
  it('is_false_when_workspace_sentToday_is_zero_or_absent', () => {
    expect(deriveHasSentMessage(undefined)).toBe(false);
    expect(deriveHasSentMessage(0)).toBe(false);
  });

  it('is_true_when_workspace_sentToday_is_positive', () => {
    expect(deriveHasSentMessage(1)).toBe(true);
    expect(deriveHasSentMessage(42)).toBe(true);
  });
});

describe('deriveHasWalletFunds', () => {
  it('is_true_only_for_the_active_state', () => {
    expect(deriveHasWalletFunds({ state: 'active' })).toBe(true);
  });

  it.each(['low', 'empty', 'frozen'] as const)('is_false_for_the_%s_state', (state) => {
    expect(deriveHasWalletFunds({ state })).toBe(false);
  });

  it('is_false_while_the_wallet_query_has_no_data_yet', () => {
    expect(deriveHasWalletFunds(undefined)).toBe(false);
  });
});

describe('deriveOutcomeSegments', () => {
  it('splits_sent_failed_waiting_into_exact_percentages', () => {
    const segments = deriveOutcomeSegments({ sentToday: 5, failedToday: 1, waiting: 4 });
    expect(segments).toEqual([
      { id: 'sent', label: expect.any(String), value: 5, tone: 'success' },
      { id: 'failed', label: expect.any(String), value: 1, tone: 'danger' },
      { id: 'waiting', label: expect.any(String), value: 4, tone: 'info' },
    ]);
    const total = segments.reduce((acc, segment) => acc + segment.value, 0);
    expect(total).toBe(10);
  });

  it('all_zero_produces_zero_value_segments_never_a_division_error', () => {
    const segments = deriveOutcomeSegments({ sentToday: 0, failedToday: 0, waiting: 0 });
    expect(segments.every((segment) => segment.value === 0)).toBe(true);
  });
});

describe('deriveFleetHealth', () => {
  it('mean_of_two_scores_90_and_70_is_exactly_80', () => {
    const items = [
      item({ instanceId: 'a', healthScore: 90, healthBand: 'HEALTHY' }),
      item({ instanceId: 'b', healthScore: 70, healthBand: 'WATCH' }),
    ];
    const result = deriveFleetHealth(items);
    expect(result.meanScore).toBe(80);
    expect(result.bandCounts).toEqual({ HEALTHY: 1, WATCH: 1, DEGRADED: 0, CRITICAL: 0 });
  });

  it('items_with_a_null_healthScore_are_excluded_from_the_mean_but_still_counted_by_band', () => {
    const items = [
      item({ instanceId: 'a', healthScore: 100, healthBand: 'HEALTHY' }),
      item({ instanceId: 'b', healthScore: null, healthBand: 'CRITICAL' }),
    ];
    const result = deriveFleetHealth(items);
    expect(result.meanScore).toBe(100);
    expect(result.bandCounts.CRITICAL).toBe(1);
  });

  it('an_empty_fleet_has_a_zero_mean_and_all_zero_band_counts', () => {
    const result = deriveFleetHealth([]);
    expect(result.meanScore).toBe(0);
    expect(result.bandCounts).toEqual({ HEALTHY: 0, WATCH: 0, DEGRADED: 0, CRITICAL: 0 });
  });
});

describe('deriveKpiHints', () => {
  it('connected_numbers_hint_reports_the_exact_needsAction_count_when_positive', () => {
    const hint = deriveKpiHints({
      connectedNumbers: 3,
      needsActionCount: 2,
      queuedAcrossCount: 3,
      failedToday: 0,
    });
    expect(hint.connectedNumbersHintKey).toBe('needsAction');
    expect(hint.connectedNumbersHintVars).toEqual({ count: 2 });
  });

  it('connected_numbers_hint_is_all_healthy_when_positive_and_none_need_action', () => {
    const hint = deriveKpiHints({
      connectedNumbers: 3,
      needsActionCount: 0,
      queuedAcrossCount: 3,
      failedToday: 0,
    });
    expect(hint.connectedNumbersHintKey).toBe('allHealthy');
  });

  it('connected_numbers_hint_is_none_connected_when_the_fleet_is_empty', () => {
    const hint = deriveKpiHints({
      connectedNumbers: 0,
      needsActionCount: 0,
      queuedAcrossCount: 0,
      failedToday: 0,
    });
    expect(hint.connectedNumbersHintKey).toBe('noneConnected');
  });

  it('queued_hint_carries_the_exact_across_count', () => {
    const hint = deriveKpiHints({
      connectedNumbers: 3,
      needsActionCount: 0,
      queuedAcrossCount: 3,
      failedToday: 0,
    });
    expect(hint.queuedHintVars).toEqual({ count: 3 });
  });

  it('sent_hint_carries_the_exact_failedToday_count', () => {
    const hint = deriveKpiHints({
      connectedNumbers: 3,
      needsActionCount: 0,
      queuedAcrossCount: 3,
      failedToday: 1,
    });
    expect(hint.sentHintVars).toEqual({ failed: 1 });
  });
});
