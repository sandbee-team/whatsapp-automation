import type { TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { runOneMediaRetentionPurge } from '../../modules/media/index.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import { DB_ERROR_BACKOFF_MS, type CronWiringPool } from './cron-wiring.js';
import { listActiveClientIds } from './cron-wiring-contacts-maintenance.js';

/**
 * cron-wiring-media-maintenance.ts (P34 U-upload, ADR 0052 accepted item 7)
 * - composes the hourly media-asset retention purge loop on top of
 * `cron-loop.ts`/`single-flight.ts`, the SAME idiom
 * `cron-wiring-contacts-maintenance.ts` establishes for its own purge loop -
 * split into its own sibling module rather than added to that file, since
 * this is a DIFFERENT module's (`modules/media`, not `modules/contacts`)
 * maintenance cadence and the contacts file already carries two loops.
 * Reuses that file's own `listActiveClientIds` (the same bounded,
 * cursor-paginated cross-tenant client walk) rather than duplicating it.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface CreateMediaMaintenanceLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  objectStore: ObjectStore;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  /** Bounded page size for each tick's client walk. Defaults 5000 (ADR 0018 S4). */
  clientsPerSweep?: number;
}

export interface MediaMaintenanceLoops {
  mediaPurgeLoop: CronLoop;
}

/** Builds the media-asset retention purge loop (hourly), driven by its own rotating cursor over `listActiveClientIds`. */
export function createMediaMaintenanceLoops(
  deps: CreateMediaMaintenanceLoopsDeps,
): MediaMaintenanceLoops {
  const clientsPerSweep = deps.clientsPerSweep ?? 5000;

  let purgeCursor = NIL_UUID;

  async function listClientIdsForPurge(): Promise<string[]> {
    const page = await listActiveClientIds(deps.pool, {
      afterId: purgeCursor,
      limit: clientsPerSweep,
    });
    const last = page[page.length - 1];
    purgeCursor = last ?? NIL_UUID;
    return page;
  }

  const mediaPurgeLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.mediaAssetPurge, async () => {
        await runOneMediaRetentionPurge({
          tenantDb: deps.tenantDb,
          objectStore: deps.objectStore,
          listClientIds: listClientIdsForPurge,
          now: () => new Date(),
          retentionDays: 90,
        });
      }),
    intervalMs: TIMING.mediaAssetPurgeIntervalMs,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('media-asset-purge', outcome, error);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { mediaPurgeLoop };
}

/** Common arming shape every always-optional cron loop group in `cron-wiring.ts` takes - `objectStore` alone gates this one (never `keyProvider`, unlike `contactsLoops`). Reclaims the inline ternary from `createCronWiring` itself (max-lines discipline). */
export interface ArmMediaLoopsDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  objectStore?: ObjectStore;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
}

/** Arms `mediaLoops` only when `deps.objectStore` is supplied - `undefined` otherwise (fail-safe default: omitted = none, same idiom `contactsLoops` uses). */
export function armMediaLoops(deps: ArmMediaLoopsDeps): MediaMaintenanceLoops | undefined {
  if (!deps.objectStore) return undefined;
  return createMediaMaintenanceLoops({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    objectStore: deps.objectStore,
    rng: deps.rng,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    logOutcome: deps.logOutcome,
  });
}
