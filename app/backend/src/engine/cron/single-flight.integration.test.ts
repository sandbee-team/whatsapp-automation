import { createPool } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { CRON_LOCK_KEYS, runWithSingleFlightLock } from './single-flight.js';

/**
 * single-flight.integration.test.ts (P12 Unit U4, step 7) - proves the
 * `pg_try_advisory_xact_lock` single-flight primitive against REAL
 * Postgres: two concurrent transactions racing for the SAME lock key, the
 * second observing `lock_not_acquired` while the first still holds it, and
 * the lock releasing at COMMIT (not at session end) - the whole reason for
 * the `_xact_` variant over a plain session-scoped advisory lock (see
 * `single-flight.ts`'s own module doc). Asserts the INVARIANT itself (at
 * most one holder at a time, never lost after commit) rather than any
 * sampled/racy count.
 */

let pool: ReturnType<typeof createPool>;

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'wp-cron-test' });
});

afterAll(async () => {
  await pool.end();
});

describe('runWithSingleFlightLock (real Postgres)', () => {
  it('a_second_holder_of_the_same_lock_key_observes_lock_not_acquired_while_the_first_still_holds_it', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstHolding = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = false;

    const firstRun = runWithSingleFlightLock(pool, CRON_LOCK_KEYS.reaper, async () => {
      firstEntered = true;
      await firstHolding;
    });

    // Wait until the first transaction has actually entered `fn` (i.e. has
    // already taken the lock) before racing the second - a fixed poll on a
    // boolean flip, not a sleep on wall-clock time.
    while (!firstEntered) {
      await new Promise((r) => setImmediate(r));
    }

    const second = await runWithSingleFlightLock(pool, CRON_LOCK_KEYS.reaper, async () => {
      throw new Error('second holder must never run fn while the first still holds the lock');
    });

    expect(second.outcome).toBe('lock_not_acquired');

    releaseFirst?.();
    const first = await firstRun;
    expect(first.outcome).toBe('ran');
  });

  it('the_lock_releases_at_commit_so_a_fresh_attempt_after_the_first_finishes_succeeds', async () => {
    const first = await runWithSingleFlightLock(pool, CRON_LOCK_KEYS.reconciler, async () => {
      // no-op body - just prove the lock is taken and released cleanly.
    });
    expect(first.outcome).toBe('ran');

    const second = await runWithSingleFlightLock(pool, CRON_LOCK_KEYS.reconciler, async () => {
      // no-op body.
    });
    expect(second.outcome).toBe('ran');
  });

  it('the_reaper_and_reconciler_lock_keys_are_distinct_so_they_can_be_held_concurrently', async () => {
    let releaseReaper: (() => void) | undefined;
    const reaperHolding = new Promise<void>((resolve) => {
      releaseReaper = resolve;
    });
    let reaperEntered = false;

    const reaperRun = runWithSingleFlightLock(pool, CRON_LOCK_KEYS.reaper, async () => {
      reaperEntered = true;
      await reaperHolding;
    });

    while (!reaperEntered) {
      await new Promise((r) => setImmediate(r));
    }

    const reconcilerRun = await runWithSingleFlightLock(
      pool,
      CRON_LOCK_KEYS.reconciler,
      async () => {
        // Must be able to run concurrently with the reaper's held lock.
      },
    );

    expect(reconcilerRun.outcome).toBe('ran');

    releaseReaper?.();
    const reaperResult = await reaperRun;
    expect(reaperResult.outcome).toBe('ran');
  });
});
