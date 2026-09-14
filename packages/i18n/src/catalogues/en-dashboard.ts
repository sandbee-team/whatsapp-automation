import type { Catalogue } from './catalogue-type.js';

/**
 * English strings for the 2026-09-08 dashboard refresh (KPI hint lines, the
 * "Sending today"/"Today's outcomes" cards, fleet health, and the wallet
 * card); hi-dashboard.ts mirrors every key. Pre-existing `dashboard.*` keys
 * (title, checklist, activity, numbers grid) already live in `en.ts`/
 * `en-instances-ui.ts` (a different unit's scope) and are reused as-is; only
 * the NEW strings this refresh introduces are added here. Honest copy only:
 * the wallet estimate is explicitly framed as an estimate, never a promise
 * (core invariant 6) - no capacity figures, no delivery-speed claims.
 */
export const enDashboard = {
  'dashboard.kpi.connectedNumbers.needsAction': '{count} need attention',
  'dashboard.kpi.connectedNumbers.allHealthy': 'All healthy',
  'dashboard.kpi.connectedNumbers.noneConnected': 'None connected yet',
  'dashboard.kpi.queued.acrossNumbers': 'across {count} numbers',
  'dashboard.kpi.sent.failedToday': 'today, {failed} failed',
  'dashboard.kpi.spentToday.balance': 'balance {balance}',

  'dashboard.numbers.cardTitle': 'Sending today',
  'dashboard.numbers.meta.waiting': 'waiting {count}',

  'dashboard.outcomes.cardTitle': "Today's outcomes",
  'dashboard.outcomes.label': "Today's outcomes",
  'dashboard.outcomes.centre.messages': 'messages',
  'dashboard.outcomes.centre.empty': 'Nothing sent yet today',
  'dashboard.outcomes.segment.sent': 'Sent',
  'dashboard.outcomes.segment.failed': 'Failed',
  'dashboard.outcomes.segment.waiting': 'Waiting',

  'dashboard.fleetHealth.cardTitle': 'Fleet health',
  'dashboard.fleetHealth.label': 'Fleet health {score} of 100',
  'dashboard.fleetHealth.empty': 'Connect a number to start tracking health',
  'dashboard.fleetHealth.band.HEALTHY': 'Healthy',
  'dashboard.fleetHealth.band.WATCH': 'Watch',
  'dashboard.fleetHealth.band.DEGRADED': 'Degraded',
  'dashboard.fleetHealth.band.CRITICAL': 'Critical',

  'dashboard.wallet.cardTitle': 'Wallet',
  'dashboard.wallet.estimate':
    'Roughly {count} messages at the current top rate - an estimate, not a promise.',
  'dashboard.wallet.addFunds': 'Add funds',
} as const satisfies Catalogue;
