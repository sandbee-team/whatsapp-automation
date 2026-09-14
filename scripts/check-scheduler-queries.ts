import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import { scanSchedulerQueries } from './guards/scheduler-queries-lib.js';
import type { SourceFile } from './guards/scheduler-queries-lib.js';

/**
 * check-scheduler-queries.ts (P16 gap-closer, item 1 - scope-delta row 4:
 * "CI check: no query in the scheduler module without a LIMIT"). Every
 * bounded, periodic, cross-tenant scan loop must load only `.sql` files that
 * carry a `LIMIT` clause - a singleton scheduler loop scanning without a
 * bound is exactly the "O(active instances)" regression ADR 0018 S4
 * forbids (a 10k-session fleet turns one unbounded scan into a full-table
 * read every tick).
 *
 * SCHEDULER_LOOP_MODULES is a PINNED list (discovered by inspecting every
 * periodic-tick loop module in the repo at the time this guard was written -
 * a NEW scheduler loop anywhere else must be added here, same discipline as
 * check-health-writers.ts's own pinned allow-lists):
 *
 *   - engine/pacing/warmup-evaluator.ts - the 5-minute per-instance
 *     pacing/warmup-tier evaluator sweep. Loads NO `.sql` file via
 *     `loadQuery` (its due-scan runs through the `wp_warmup_scan_due`
 *     SECURITY DEFINER function via a raw `pool.query` call, not a
 *     `db/queries/*.sql` file) - contributes zero query names, which is
 *     correct, not a guard gap: the function's own bound (`p_limit`,
 *     migration 0034/0035) is enforced at the database layer, not by a
 *     loadable query file this guard could inspect.
 *   - modules/pacing/health/evaluator-loop.ts - the health-evaluator due-scan
 *     sweep (loads `health-due`).
 *   - modules/pacing/health/retention.ts - the 30-day
 *     `instance_health_samples` retention sweep (loads
 *     `health-samples-retention`).
 *   - engine/fleet/discovery.ts - the fleet-wide discovery loop (loads
 *     `discover-instances` directly) plus its own FIX-P09-B sibling split
 *     modules `discovery-caps.ts` (loads `fleet-gauges`) and
 *     `discovery-escalation.ts` (loads `instance-mark-infra-unavailable`) -
 *     both included here since `discovery.ts` imports and re-exports them
 *     as part of the SAME loop unit (see discovery.ts's own header comment).
 *   - modules/wallet/rollup.ts - the hourly wallet rollup sweep (P18 U8b;
 *     loads `wallet-reconcile`'s `wallet-rollup-compute` section via
 *     `loadNamedQuery`, the cross-tenant half - the per-tenant
 *     `wallet-rollup-upsert` section is a keyed per-client write, never a
 *     fleet-wide scan).
 *   - modules/wallet/reconcile.ts (+ reconcile-checks.ts) - the hourly wallet
 *     reconciler sweep (P18 U8b; checks A-E, each a bounded
 *     `loadNamedQuery('wallet-reconcile', ...)` section).
 *   - modules/wallet/charger.worker.ts - the wallet-charger drain loop (P18
 *     U5; armed by `cron-wiring-wallet.ts` at
 *     `TIMING.walletChargerDrainIntervalMs`). Loads NO `db/queries/*.sql`
 *     file - it is a periodic Redis drain loop, bounded entirely at the
 *     Redis-command layer (`maxClientsPerDrain`/`maxItemsPerClient` cap each
 *     tick's SPOP/RPOP calls) and, for the money it moves, at the guard-
 *     first `chargeRepairedSend` layer - contributes zero query names, the
 *     same shape as `warmup-evaluator.ts` above, not a guard gap.
 *   - modules/contacts/import-runner.ts - the resumable CSV import sweep
 *     (P20 U5; loads `contact-imports-pending-clients`).
 *   - modules/contacts/mirror-reconcile.ts - the nightly opt-out mirror
 *     reconciler sweep (P20 U7/U8; loads `reconcile-optout-mirror`).
 *   - modules/contacts/retention-purge.ts - the hourly import-error/object
 *     retention purge sweep (P20 U7/U8; loads `purge-import-errors`).
 *   - engine/cron/cron-wiring-contacts-maintenance.ts - the shared bounded
 *     cross-tenant client walk both sweeps above use (P20 U8; loads
 *     `contacts-active-clients`).
 *   - modules/broadcasts/funnel.sweep.ts - the progress-funnel recompute
 *     sweep (P23a U2; loads `broadcast-funnel-pending`'s two named sections,
 *     `funnel-active`/`funnel-hourly`, each via its own literal-pair
 *     `loadNamedQuery` call site).
 *   - platform/metrics/db-collector.ts - the 5-minute fleet rollup collector
 *     (P25 U3; loads `metric-rollups`' `metric-rollup-fleet` section).
 *   - modules/inbound/optout-rate-check.ts - the hourly per-client opt-out-
 *     rate check (P25 U3; loads `metric-rollups`' `optout-rate-flagged-
 *     clients` section, bounded by its own `$limit`).
 *   - engine/cron/cron-wiring-rollups.ts - composes the two loops above
 *     (P25 U3; loads no `.sql` file itself, contributes zero query names -
 *     same class as `cron-wiring-contacts-maintenance.ts`'s own composition
 *     role, not a guard gap).
 */
export const SCHEDULER_LOOP_MODULES: readonly string[] = [
  'app/backend/src/engine/pacing/warmup-evaluator.ts',
  'app/backend/src/modules/pacing/health/evaluator-loop.ts',
  'app/backend/src/modules/pacing/health/retention.ts',
  'app/backend/src/engine/fleet/discovery.ts',
  'app/backend/src/engine/fleet/discovery-caps.ts',
  'app/backend/src/engine/fleet/discovery-escalation.ts',
  'app/backend/src/modules/wallet/rollup.ts',
  'app/backend/src/modules/wallet/reconcile.ts',
  'app/backend/src/modules/wallet/reconcile-checks.ts',
  'app/backend/src/modules/wallet/charger.worker.ts',
  'app/backend/src/modules/contacts/import-runner.ts',
  'app/backend/src/modules/contacts/mirror-reconcile.ts',
  'app/backend/src/modules/contacts/retention-purge.ts',
  'app/backend/src/engine/cron/cron-wiring-contacts-maintenance.ts',
  'app/backend/src/modules/broadcasts/funnel.sweep.ts',
  'app/backend/src/platform/metrics/db-collector.ts',
  'app/backend/src/modules/inbound/optout-rate-check.ts',
  'app/backend/src/engine/cron/cron-wiring-rollups.ts',
];

/** Every `db/queries/*.sql` file - resolved once per run and looked up by base name. */
export const SCHEDULER_QUERIES_GLOBS = ['db/queries/**/*.sql'];

function readModuleFiles(paths: readonly string[]): SourceFile[] {
  return paths.map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function readQueryFilesByName(): Map<string, SourceFile> {
  const files = resolveFiles(SCHEDULER_QUERIES_GLOBS);
  const byName = new Map<string, SourceFile>();
  for (const relativePath of files) {
    const name = path.basename(relativePath, '.sql');
    byName.set(name, {
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    });
  }
  return byName;
}

export function runCheckSchedulerQueries(): GuardResult {
  const modules = readModuleFiles(SCHEDULER_LOOP_MODULES);
  const queriesByName = readQueryFilesByName();
  const violations = scanSchedulerQueries(modules, queriesByName);

  const guardViolations: GuardViolation[] = violations.map((v) => ({
    file: v.module,
    message: v.message,
  }));

  return { violations: guardViolations, filesScanned: modules.length };
}

function main(): void {
  if (SCHEDULER_LOOP_MODULES.length === 0) {
    throw new Error('check-scheduler-queries: SCHEDULER_LOOP_MODULES must not be empty');
  }

  const result = runCheckSchedulerQueries();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`check-scheduler-queries: ${violation.file} - ${violation.message}`);
    }
    console.log(
      `check-scheduler-queries: ${String(result.filesScanned ?? 0)} module(s) scanned, ` +
        `${String(result.violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(
    `check-scheduler-queries: ${String(result.filesScanned ?? 0)} module(s) scanned, 0 violations`,
  );
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
