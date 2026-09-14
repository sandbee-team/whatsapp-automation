import type { TenantDb } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { TIMING } from '@wp/domain';
import {
  runOneMirrorReconcileSweep,
  runOneImportRetentionPurge,
} from '../../modules/contacts/index.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import type { ContactsMetricsHandles } from '../../platform/metrics/contacts.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import { DB_ERROR_BACKOFF_MS, type CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring-contacts-maintenance.ts (P20 Unit U8, step 8) - composes the
 * two contacts MAINTENANCE cadences (the nightly opt-out mirror reconciler
 * and the hourly import-error/object retention purge) on top of
 * `cron-loop.ts`/`single-flight.ts`. Split out of `cron-wiring-contacts.ts`
 * purely for that file's own max-lines cap - same split idiom as
 * `cron-wiring-wallet.ts`.
 *
 * `listActiveClientIds` is the bounded, cursor-paginated cross-tenant client
 * walk (`db/queries/contacts-active-clients.sql`) BOTH loops below share via
 * `deps.listClientIds` - a plain, stateless one-page read; the ROTATING
 * cursor that lets a sweep eventually reach every client across several
 * ticks lives in `createContactsMaintenanceLoops` itself (a module-level
 * `let`, wrapping to the nil uuid once a page comes back empty), never in
 * this function.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface ListActiveClientIdsOptions {
  afterId: string;
  limit: number;
}

/** One bounded page of live (`deleted_at IS NULL`) client ids, ordered by id, strictly after `afterId`. */
export async function listActiveClientIds(
  pool: CronWiringPool,
  options: ListActiveClientIdsOptions,
): Promise<string[]> {
  const query = await loadQuery('contacts-active-clients');
  const result = await pool.query<{ client_id: string }>(
    query.text,
    bindQueryParams(query, { after_id: options.afterId, limit: options.limit }),
  );
  return result.rows.map((row) => row.client_id);
}

export interface CreateContactsMaintenanceLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  objectStore: ObjectStore;
  metrics: ContactsMetricsHandles;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  /** Bounded page size for each tick's client walk. Defaults 5000 (ADR 0018 S4). */
  clientsPerSweep?: number;
}

export interface ContactsMaintenanceLoops {
  mirrorReconcileLoop: CronLoop;
  importPurgeLoop: CronLoop;
}

/** Builds the opt-out mirror reconciler (daily) and the import retention purge (hourly) loops, each single-flighted and driven by its own rotating cursor over `listActiveClientIds`. */
export function createContactsMaintenanceLoops(
  deps: CreateContactsMaintenanceLoopsDeps,
): ContactsMaintenanceLoops {
  const clientsPerSweep = deps.clientsPerSweep ?? 5000;

  // Each loop rotates its OWN cursor independently - the reconciler and the
  // purge sweep at different cadences and must not share progress state.
  let mirrorCursor = NIL_UUID;
  let purgeCursor = NIL_UUID;

  async function listClientIdsForMirror(): Promise<string[]> {
    const page = await listActiveClientIds(deps.pool, {
      afterId: mirrorCursor,
      limit: clientsPerSweep,
    });
    const last = page[page.length - 1];
    mirrorCursor = last ?? NIL_UUID;
    return page;
  }

  async function listClientIdsForPurge(): Promise<string[]> {
    const page = await listActiveClientIds(deps.pool, {
      afterId: purgeCursor,
      limit: clientsPerSweep,
    });
    const last = page[page.length - 1];
    purgeCursor = last ?? NIL_UUID;
    return page;
  }

  const mirrorReconcileLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.optoutMirrorReconcile, async () => {
        await runOneMirrorReconcileSweep({
          tenantDb: deps.tenantDb,
          listClientIds: listClientIdsForMirror,
          metrics: { incOptoutMirrorDrift: (n) => deps.metrics.optoutMirrorDriftTotal.inc(n) },
        });
      }),
    intervalMs: TIMING.optoutMirrorReconcileIntervalMs,
    jitterMs: 600_000,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('optout-mirror-reconcile', outcome, error);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  const importPurgeLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.contactImportPurge, async () => {
        await runOneImportRetentionPurge({
          tenantDb: deps.tenantDb,
          objectStore: deps.objectStore,
          listClientIds: listClientIdsForPurge,
          now: () => new Date(),
          retentionDays: 30,
        });
      }),
    intervalMs: TIMING.contactImportPurgeIntervalMs,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('contact-import-purge', outcome, error);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { mirrorReconcileLoop, importPurgeLoop };
}
