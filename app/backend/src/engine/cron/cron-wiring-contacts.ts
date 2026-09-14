import type { TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { runOneContactImportSweep } from '../../modules/contacts/import-runner.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import type { ContactsMetricsHandles } from '../../platform/metrics/contacts.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import { DB_ERROR_BACKOFF_MS, type CronWiringPool } from './cron-wiring.js';
import {
  createContactsMaintenanceLoops,
  type ContactsMaintenanceLoops,
} from './cron-wiring-contacts-maintenance.js';

/**
 * cron-wiring-contacts.ts (P20 Unit U5, step 6; P20 Unit U8, step 8 appends
 * `createContactsCronLoops`) - composes the resumable CSV import sweep
 * cadence on top of `cron-loop.ts`/`single-flight.ts`, same split idiom as
 * `cron-wiring-wallet.ts`. The two MAINTENANCE loops (opt-out mirror
 * reconciler + import retention purge) live in the sibling
 * `cron-wiring-contacts-maintenance.ts` (this file's own 300-line cap) -
 * `createContactsCronLoops` below composes all three into the one object
 * `cron-wiring.ts` wires in.
 */

export interface CreateContactImportCronLoopDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
  objectStore: ObjectStore;
  metrics: ContactsMetricsHandles;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
}

/** Builds the contact-import sweep loop: single-flighted, `TIMING.contactImportTickMs` cadence, bounded backoff on `db_error`. */
export function createContactImportCronLoop(deps: CreateContactImportCronLoopDeps): CronLoop {
  return createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.contactImport, async () => {
        await runOneContactImportSweep({
          pool: deps.pool,
          tenantDb: deps.tenantDb,
          keyProvider: deps.keyProvider,
          objectStore: deps.objectStore,
          metrics: deps.metrics,
        });
      }),
    intervalMs: TIMING.contactImportTickMs,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('contact-import', outcome, error);
    },
    backoffScheduleMs: DB_ERROR_BACKOFF_MS,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });
}

export interface CreateContactsCronLoopsDeps extends CreateContactImportCronLoopDeps {
  clientsPerSweep?: number;
}

export interface ContactsCronLoops extends ContactsMaintenanceLoops {
  importLoop: CronLoop;
}

/** Composes all three contacts cron loops (import sweep + the two maintenance sweeps) - `roles/cron.ts` calls this once and starts/stops the result alongside every other loop. */
export function createContactsCronLoops(deps: CreateContactsCronLoopsDeps): ContactsCronLoops {
  const importLoop = createContactImportCronLoop(deps);
  const { mirrorReconcileLoop, importPurgeLoop } = createContactsMaintenanceLoops({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    objectStore: deps.objectStore,
    metrics: deps.metrics,
    rng: deps.rng,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
    logOutcome: deps.logOutcome,
    clientsPerSweep: deps.clientsPerSweep,
  });
  return { importLoop, mirrorReconcileLoop, importPurgeLoop };
}
