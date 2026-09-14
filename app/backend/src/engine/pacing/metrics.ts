import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { WarmupMetrics } from './warmup-evaluator.js';

/**
 * engine/pacing/metrics.ts (P13a Unit U2, step 10) - the four pacing
 * metrics named by P13's own step 10: `wp_pacing_reserve_seconds`
 * (histogram, no label), `wp_pacing_deferrals_total{reason}`,
 * `wp_pacing_denies_total{reason}`, and `wp_warmup_tier_changes_total
 * {result}`. Same idempotent-registration `WeakMap` pattern as
 * `engine/queue/metrics.ts` / `platform/metrics/lease-metrics.ts`.
 *
 * CARRIED-OVER BLOCKER (P13a step 2, binding): canon names the tier-change
 * label `direction`, but `direction` is NOT in `@wp/server-kit`'s
 * `ALLOWED_LABELS` (`packages/server-kit/src/obs/metric-policy.ts`) and
 * adding a new label name requires an ADR. `wp_warmup_tier_changes_total`
 * therefore uses the already-allowed **`result`** label with values
 * `advance`/`rollback` - the same substitution `wp_reaper_repairs_total
 * {result}` made in P12 for an identical reason. Do NOT widen
 * `ALLOWED_LABELS` to add `direction` from this module.
 *
 * `wp_pacing_deferrals_total{reason}` PRE-EXISTED this module: P13 Unit U4
 * defined it locally in `engine/queue/send-loop-pacing-deferral-metrics.ts`
 * (that file's own header names this exact consolidation as P13a's job)
 * because `engine/pacing/metrics.ts` did not exist yet at P13 close. This
 * module is now the single registration point for that counter name -
 * `send-loop-worker-wiring.ts` is repointed at `bindPacingMetrics`, and the
 * now-redundant sibling file is emptied to a no-op marker (never register
 * the same metric name twice against the shared default registry -
 * `prom-client` throws).
 *
 * `wp_pacing_denies_total{reason}` is registered per canon but has no
 * production call site yet: the only "deny" path this repo has today is
 * `engine/pacing/index.ts#reserve()`'s denial, and per that module's own
 * header + invariant 5 ("pause preserves work") a denial is a REQUEUE, not
 * a permanent refusal - it is the deferral counter above, never a distinct
 * hard-deny event. The name is reserved for a future genuinely-terminal
 * pacing refusal (e.g. a plan-level hard block) so canon's four-metric
 * shape is satisfied without inventing a fake call site now.
 */

export interface PacingMetricsHandles {
  reserveSeconds: ReturnType<MetricsRegistry['histogram']>;
  deferralsTotal: ReturnType<MetricsRegistry['counter']>;
  deniesTotal: ReturnType<MetricsRegistry['counter']>;
  tierChangesTotal: ReturnType<MetricsRegistry['counter']>;
  /** Ready-to-wire `WarmupMetrics` seam (`warmup-evaluator.ts`) - `tierChange(result)` increments `tierChangesTotal`. */
  warmupMetrics: WarmupMetrics;
}

const registeredMetrics = new WeakMap<MetricsRegistry, PacingMetricsHandles>();

export function bindPacingMetrics(
  registry: MetricsRegistry = defaultMetrics,
): PacingMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const reserveSeconds = registry.histogram(
    'wp_pacing_reserve_seconds',
    'Wall time of reserve() round trips (claim + reserve, in seconds)',
  );
  const deferralsTotal = registry.counter(
    'wp_pacing_deferrals_total',
    'Pacing reserve denials, by reason - a deferral (requeue), never a job failure (label name: reason)',
    ['reason'],
  );
  const deniesTotal = registry.counter(
    'wp_pacing_denies_total',
    'Terminal pacing refusals, by reason - reserved for a future hard-deny path (label name: reason)',
    ['reason'],
  );
  const tierChangesTotal = registry.counter(
    'wp_warmup_tier_changes_total',
    'Warm-up ladder tier changes applied by the pacing evaluator (label name: result, not direction - see module doc)',
    ['result'],
  );

  const handles: PacingMetricsHandles = {
    reserveSeconds,
    deferralsTotal,
    deniesTotal,
    tierChangesTotal,
    warmupMetrics: {
      tierChange: (result) => tierChangesTotal.inc({ result }),
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
