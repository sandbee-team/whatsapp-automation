/**
 * obs-exports.ts (P25 observability-and-runbook, unit U1a) - sibling barrel
 * split for the observability inventory, same reasoning as
 * `enums-exports.ts`/`realtime` re-exports already in `index.ts`: keeps
 * `index.ts` itself under the `max-lines: 300` cap while still surfacing
 * everything through the single `@wp/domain` package entry point.
 */
export {
  METRIC_INVENTORY,
  CORE_METRIC_INVENTORY,
  type MetricType,
  type MetricInventoryEntry,
} from './obs/metric-inventory.js';

export { SESSION_METRIC_INVENTORY } from './obs/metric-inventory-session.js';
export { ROLLUP_METRIC_INVENTORY } from './obs/metric-inventory-rollups.js';
