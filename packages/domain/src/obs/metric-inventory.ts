import { SESSION_METRIC_INVENTORY } from './metric-inventory-session.js';
import { ROLLUP_METRIC_INVENTORY } from './metric-inventory-rollups.js';
import { CORE_METRIC_INVENTORY_A_M } from './metric-inventory-core-a-m.js';
import { CORE_METRIC_INVENTORY_N_R } from './metric-inventory-core-n-r.js';
import { CORE_METRIC_INVENTORY_S_Z } from './metric-inventory-core-s-z.js';

/**
 * metric-inventory.ts (P25 observability-and-runbook, unit U1a) - the ONE
 * canonical inventory of every `wp_*` Prometheus metric in the system. Pure
 * frozen data only (`@wp/domain` stays browser-pure: no Node builtins, no
 * I/O, no `Date.now()` - depcruise rule `domain-must-be-pure-core` + eslint
 * `wp/domain-no-wallclock`). `scripts/check-metric-inventory.ts` diffs this
 * against every `counter(/gauge(/histogram(` call site in the shipped tree
 * and fails the build on any disagreement; `scripts/gen-metric-manifest.ts`
 * renders it to the committed `infra/observability/metrics.generated.json`.
 *
 * The 82-entry core list is alphabetically split across three sibling
 * data-only modules (`metric-inventory-core-a-m.ts` / `-n-r.ts` / `-s-z.ts`)
 * purely to stay under the `max-lines: 300` cap (core-invariants.md's
 * sanctioned split idiom) - this file owns only the shared types and the
 * final concatenation, never the split boundary's meaning.
 *
 * Naming reconciliation (scope-delta vs. this inventory's actual names):
 * the scope-delta's `wp_inbox_shed_total` IS the existing
 * `wp_inbound_shed_total`, and the scope-delta's
 * `wp_inbox_inbound_total{msg_type}` IS the existing
 * `wp_inbound_events_total{kind}` - "inbox" was retired to v2 (ADR 0021), so
 * there is deliberately no second metric series for the same underlying
 * fact under an "inbox" name.
 *
 * DEFERRED (do not add until a v1 mechanism emits them):
 * `wp_pacing_orphan_reservations_total` and `wp_pacing_ledger_repair_total`
 * have no v1 code path that would ever increment them - registering a metric
 * nothing emits is worse than omitting it (a permanently-zero series with no
 * emitter looks like silent failure, not like "not built yet").
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricInventoryEntry {
  /** Full `wp_` name, exactly as passed to `registry.counter/gauge/histogram(...)`. */
  readonly name: string;
  readonly type: MetricType;
  /** Exact label names, in the order the registration declares them; `[]` when none. */
  readonly labels: readonly string[];
  /** Repo-relative (posix) path of the file that registers this metric. */
  readonly module: string;
  /** True when an alert or recording rule under infra/observability reads this series. */
  readonly alerts: boolean;
  /** Copied verbatim from the registration's help-string argument. */
  readonly help: string;
}

export const CORE_METRIC_INVENTORY: readonly MetricInventoryEntry[] = Object.freeze([
  ...CORE_METRIC_INVENTORY_A_M,
  ...CORE_METRIC_INVENTORY_N_R,
  ...CORE_METRIC_INVENTORY_S_Z,
]);

/**
 * The full canonical inventory: core (this file) plus the two sibling
 * arrays owned by later P25 units. Concatenation order does not matter for
 * lookup correctness (the guard treats this as a set keyed by `name`).
 */
export const METRIC_INVENTORY: readonly MetricInventoryEntry[] = Object.freeze([
  ...CORE_METRIC_INVENTORY,
  ...SESSION_METRIC_INVENTORY,
  ...ROLLUP_METRIC_INVENTORY,
]);
