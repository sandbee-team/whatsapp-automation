import type { ChartTone } from '@wp/ui';
import type { InstanceListItem } from '../instances/use-instance-list.js';

/**
 * dashboard-derive.ts (2026-09-08 panel refresh, unit S2) - every pure
 * derivation the dashboard page needs, kept out of the component so exact
 * arithmetic (means, percentages, hint selection) has its own unit tests
 * that never render React. `deriveHasSentMessage`/`deriveHasWalletFunds`
 * moved here unchanged from the pre-refresh `dashboard-page.tsx` (P26b C1 fix
 * round MAJOR-4/MAJOR-5's own reasoning still applies verbatim).
 */

/**
 * Whether the workspace has sent at least one message today, sourced from
 * `queue-status`'s own `workspace.sentToday` counter ONLY (P26b C1 fix round
 * MAJOR-4: the previous `sentToday + summary.sent` double-counted the SAME
 * "today" figure from two sources instead of adding two different things).
 */
export function deriveHasSentMessage(workspaceSentToday: number | undefined): boolean {
  return (workspaceSentToday ?? 0) > 0;
}

/**
 * Whether the wallet has usable funds - `active` ONLY (P26b C1 fix round
 * MAJOR-5: `frozen` was previously treated as funded alongside `active`,
 * even though a frozen wallet cannot send).
 */
export function deriveHasWalletFunds(wallet: { state: string } | undefined): boolean {
  return wallet?.state === 'active';
}

export interface OutcomeSegment {
  id: 'sent' | 'failed' | 'waiting';
  label: string;
  value: number;
  tone: ChartTone;
}

/**
 * The "Today's outcomes" donut segments: sent (success), failed (danger),
 * waiting (info) - straight from `queue-status`'s workspace counters, never
 * a synthetic split. `label` is left as the segment id here; the component
 * maps it through `t()` since this module has no i18n dependency.
 */
export function deriveOutcomeSegments(workspace: {
  sentToday: number;
  failedToday: number;
  waiting: number;
}): OutcomeSegment[] {
  return [
    { id: 'sent', label: 'sent', value: workspace.sentToday, tone: 'success' },
    { id: 'failed', label: 'failed', value: workspace.failedToday, tone: 'danger' },
    { id: 'waiting', label: 'waiting', value: workspace.waiting, tone: 'info' },
  ];
}

export type HealthBand = 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'CRITICAL';

export interface FleetHealth {
  /** Mean `healthScore` over items whose card has a non-null score, rounded to the nearest integer. 0 when the fleet is empty or no item has a score. */
  meanScore: number;
  bandCounts: Record<HealthBand, number>;
}

const EMPTY_BAND_COUNTS: Record<HealthBand, number> = {
  HEALTHY: 0,
  WATCH: 0,
  DEGRADED: 0,
  CRITICAL: 0,
};

/**
 * Fleet-wide health: the mean `healthScore` across every item whose card
 * loaded with a non-null score (an item with no card yet, or a null score,
 * is excluded from the MEAN but still counted by `healthBand` when its card
 * is present - a missing signal must never silently count as a good one).
 */
export function deriveFleetHealth(items: InstanceListItem[]): FleetHealth {
  const bandCounts: Record<HealthBand, number> = { ...EMPTY_BAND_COUNTS };
  const scores: number[] = [];

  for (const item of items) {
    const card = item.card;
    if (!card) continue;
    bandCounts[card.healthBand as HealthBand] += 1;
    if (card.healthScore !== null) scores.push(card.healthScore);
  }

  const meanScore =
    scores.length === 0
      ? 0
      : Math.round(scores.reduce((acc, score) => acc + score, 0) / scores.length);

  return { meanScore, bandCounts };
}

export type ConnectedNumbersHintKey = 'needsAction' | 'allHealthy' | 'noneConnected';

export interface KpiHints {
  connectedNumbersHintKey: ConnectedNumbersHintKey;
  connectedNumbersHintVars: { count: number } | undefined;
  queuedHintVars: { count: number };
  sentHintVars: { failed: number };
}

export interface KpiHintInput {
  connectedNumbers: number;
  needsActionCount: number;
  queuedAcrossCount: number;
  failedToday: number;
}

/**
 * Selects which hint string each KPI tile's footer line renders, plus its
 * interpolation vars - kept as one derivation so `dashboard-kpi-row.tsx`
 * never re-derives the same branching inline (spec section 5, KPI row).
 */
export function deriveKpiHints(input: KpiHintInput): KpiHints {
  const connectedNumbersHintKey: ConnectedNumbersHintKey =
    input.connectedNumbers === 0
      ? 'noneConnected'
      : input.needsActionCount > 0
        ? 'needsAction'
        : 'allHealthy';

  return {
    connectedNumbersHintKey,
    connectedNumbersHintVars:
      connectedNumbersHintKey === 'needsAction' ? { count: input.needsActionCount } : undefined,
    queuedHintVars: { count: input.queuedAcrossCount },
    sentHintVars: { failed: input.failedToday },
  };
}
