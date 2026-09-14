import type { TenantDb } from '@wp/db';
import { runOneAdminRelaxExpirySweep } from '../pacing/admin-relax-expiry.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';
import { createCronLoop, type CronLoop, type CronTickOutcome } from './cron-loop.js';
import type { CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring-admin-relax.ts (P28 Unit U3b, step 5) - the admin-relax EXPIRY
 * cadence: the loop that walks back a staff pacing relax once its mandatory
 * expiry has elapsed (see `engine/pacing/admin-relax-expiry.ts`'s own header
 * for why this sweep is what makes that expiry real rather than decorative).
 *
 * A sibling wiring module rather than an addition to `cron-wiring.ts`, which
 * sits at exactly 300/300 lines - same split idiom as `cron-wiring-epoch.ts`
 * / `cron-wiring-rollups.ts`.
 *
 * Cadence: 5 minutes (ADR 0018 S4 - "no singleton loop may be O(active)
 * faster than 5 minutes"). One bounded `LIMIT`ed cross-tenant scan per tick,
 * never one iteration per instance, so the cadence never scales with fleet
 * size. An expiry that lands up to 5 minutes late is safe by construction:
 * the sweep only ever TIGHTENS pacing back to the strict baseline, and the
 * absolute floors/ceilings that `clampAdminRelax` already enforced at write
 * time still bound the relaxed value the whole time it applies.
 */

const ADMIN_RELAX_EXPIRY_INTERVAL_MS = 5 * 60 * 1_000;

export interface CreateAdminRelaxCronLoopDeps {
  pool: CronWiringPool;
  tenantDb: TenantDb;
  rng?: { random: () => number };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  logOutcome: (loopName: string, outcome: CronTickOutcome, error?: unknown) => void;
  clock?: { now(): number };
}

export interface AdminRelaxCronLoops {
  expiryLoop: CronLoop;
}

/** Builds the single-flighted, 5-minute admin-relax expiry loop. */
export function createAdminRelaxCronLoops(deps: CreateAdminRelaxCronLoopDeps): AdminRelaxCronLoops {
  const clock = deps.clock ?? { now: () => Date.now() };

  const expiryLoop = createCronLoop({
    runOne: () =>
      runWithSingleFlightLock(deps.pool, CRON_LOCK_KEYS.adminRelaxExpiry, async () => {
        await runOneAdminRelaxExpirySweep({ pool: deps.pool, tenantDb: deps.tenantDb, clock });
      }),
    intervalMs: ADMIN_RELAX_EXPIRY_INTERVAL_MS,
    rng: deps.rng,
    onOutcome: (outcome, error) => {
      deps.logOutcome('admin-relax-expiry', outcome, error);
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });

  return { expiryLoop };
}
