import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { reserve } from './index.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * reserve-plan-cap.integration.test.ts (P13 C1 review, Finding 4 close-out) -
 * the ONLY coverage of `client_daily_usage.sent_count`, the counter the
 * plan-level `max_daily_sends` cap is enforced against.
 *
 * WHY THIS FILE EXISTS. C1 found that `sent_count` was never incremented at
 * all, so `reserve-pacing.sql`'s `AND (u.cap IS NULL OR u.sent_count < u.cap)`
 * compared a permanently-zero counter and the plan cap enforced NOTHING
 * (`PLAN_CAP` in `pacing-deny-reason.sql` was unreachable code). The fix added
 * the `usage_bump` CTE. But the fix shipped with NO test reading `sent_count`
 * back on EITHER branch, which leaves the interesting half unproven:
 *
 *   A data-modifying statement in WITH is executed EXACTLY ONCE,
 *   UNCONDITIONALLY, whether or not the primary query references its output.
 *
 * (Postgres docs; verified against live PG 17 - see
 * `.memory/lessons/2026-09-02-pacing-c1-review-fixes.md`, whose own first
 * draft asserted the opposite and was wrong.) So `usage_bump` is NOT made
 * conditional by the final SELECT's `LEFT JOIN`; it is conditional only
 * because it reads `FROM granted g`, and `granted` is empty on a denial.
 * That is a data-flow property one edit away from breaking silently, and a
 * grant-only test passes just as happily when the counter increments on
 * every attempt. Hence `a_denied_reserve_never_increments_sent_count` below -
 * it is the assertion that actually pins the bug C1 found, and the one that
 * would catch a regression that starts billing denied sends against a
 * tenant's plan usage.
 */

let pool: TestPool;
let tenantDb: TenantDb;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-plan-cap-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  // `client_limit_overrides` has an FK to `clients` and is NOT covered by the
  // shared helper (no other pacing suite writes it), so it must be cleared
  // first or the helper's `DELETE FROM clients` raises a FK violation.
  await pool.query('DELETE FROM client_limit_overrides WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Fixed instant - no ambient clock anywhere in this file. */
const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

async function readSentCount(clientId: string): Promise<number | undefined> {
  const result = await pool.query<{ sent_count: number }>(
    'SELECT sent_count FROM client_daily_usage WHERE client_id = $1',
    [clientId],
  );
  return result.rows[0]?.sent_count;
}

describe('pacing plan cap (client_daily_usage.sent_count)', () => {
  it('a_granted_reserve_increments_sent_count_by_exactly_one', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 10,
      hourlyCap: 10,
      newConvCap: 10,
    });

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });

    expect(outcome.granted).toBe(true);
    expect(await readSentCount(clientId)).toBe(1);
  });

  it('a_denied_reserve_never_increments_sent_count', async () => {
    // eff_daily_cap = 0 => every reserve denies at the daily-cap predicate,
    // so `granted` is empty and `usage_bump` must update zero rows. If
    // `usage_bump` ever stops deriving FROM granted, this is the assertion
    // that fails - a granted-only test would stay green.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 0,
      hourlyCap: 10,
      newConvCap: 10,
    });

    const before = await readSentCount(clientId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await reserve({
        sql: pool,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      expect(outcome.granted).toBe(false);
    }

    // The zero-valued row is created by `ensureDailyUsageRow` (that is
    // correct and expected); what must NOT happen is any increment.
    expect(await readSentCount(clientId)).toBe(0);
    expect(before ?? 0).toBe(0);
  });

  it('the_plan_cap_denies_at_its_boundary_and_names_plan_cap', async () => {
    // Per-instance caps are set high so the ONLY binding limit is the
    // client-wide plan cap resolved through `effective_client_limits`.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 100,
      hourlyCap: 100,
      newConvCap: 100,
    });

    await pool.query(
      `INSERT INTO client_limit_overrides (client_id, limit_key, limit_value, reason)
       VALUES ($1, 'max_daily_sends', 2, 'plan cap boundary test')`,
      [clientId],
    );

    // MUST run tenant-scoped, exactly as production does. `effective_client_
    // limits` is owned by `wp_migrator` and reads `clients`, which is RLS
    // ENABLE + *FORCE*; FORCE applies the policy even to the table owner, so
    // the view yields ZERO rows unless `app.client_id` is set. The real send
    // path always satisfies this (claim+reserve run inside
    // `TenantDb.withTenant`, which does `set_config('app.client_id', …, true)`);
    // a raw-pool query does not, and would make the plan-cap predicate read as
    // "no configured cap" - i.e. this test would silently prove nothing.
    await tenantDb.withTenant(clientId, async (tx) => {
      const reserveOnce = () =>
        reserve({
          sql: tx,
          clientId,
          instanceId,
          isNewConversation: false,
          isGroup: false,
          gapMs: 0,
          clock: fixedClock,
          timeZone: 'Asia/Kolkata',
        });

      expect((await reserveOnce()).granted).toBe(true);
      expect((await reserveOnce()).granted).toBe(true);

      // Third attempt is exactly at the cap - denied, and named PLAN_CAP
      // (unreachable code before C1 Finding 4).
      const denied = await reserveOnce();
      expect(denied.granted).toBe(false);
      if (!denied.granted) {
        expect(denied.reason).toBe('PLAN_CAP');
      }
    });

    // Two grants consumed exactly two plan units; the denial consumed none.
    expect(await readSentCount(clientId)).toBe(2);

    // P17 U6 (step 5) - a SECOND plan-cap deny the SAME instance-day still
    // yields exactly ONE `plan_cap_reached` notification (dedupeScope
    // 'instance-day').
    await tenantDb.withTenant(clientId, (tx) =>
      reserve({
        sql: tx,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      }),
    );
    const notificationRows = await pool.query<{ kind: string; requires_user_action: boolean }>(
      `SELECT kind, requires_user_action FROM notifications WHERE client_id = $1`,
      [clientId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('plan_cap_reached');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(false);
  });

  // P17 C2 hardening - hunt seam 4: the plan_cap_reached notify bucket is
  // `tenantLocalDateBucket(input.clock.now(), timeZone)` (engine/pacing/
  // index.ts), an app-side derivation from the CALLER's injected clock - but
  // whether PLAN_CAP fires at all is gated by `client_daily_usage.ledger_date`,
  // which pacing-deny-reason.sql/reserve-pacing.sql derive from REAL Postgres
  // `now()`, never from `input.clock`. The two dates are the SAME source
  // (system wall clock) in production, but this test proves the notify
  // bucket is controlled ENTIRELY by the caller-supplied clock, independent
  // of the DB's own ledger_date - two denials on the SAME real ledger_date
  // (server `now()` never moves in this test) but with the caller passing
  // two DIFFERENT clock values that cross a calendar boundary in
  // Asia/Kolkata still yield 2 separate `plan_cap_reached` notifications
  // (different dedupe buckets), not 1. This is deterministic (injected
  // clock only, real DB `now()` is never asserted on) and documents the
  // actual - not assumed - bucket authority.
  it('two_plan_cap_denies_with_clocks_straddling_local_midnight_produce_two_notifications', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 100,
      hourlyCap: 100,
      newConvCap: 100,
    });

    await pool.query(
      `INSERT INTO client_limit_overrides (client_id, limit_key, limit_value, reason)
       VALUES ($1, 'max_daily_sends', 2, 'midnight bucket test')`,
      [clientId],
    );

    // Two clocks that resolve to DIFFERENT Asia/Kolkata calendar dates -
    // 23:50 IST on 2026-09-02 vs 00:10 IST on 2026-09-03 (18:20 UTC / 18:40
    // UTC on 2026-09-02, 20 minutes apart in real time - the DB's own
    // server-clock `now()` moves by only those 20 real minutes, so both
    // reserve calls land on the SAME real ledger_date almost certainly, but
    // the notify bucket is computed from these injected clocks, not from
    // server time).
    const clockBeforeMidnightIst = { now: () => Date.UTC(2026, 8, 2, 18, 20, 0) };
    const clockAfterMidnightIst = { now: () => Date.UTC(2026, 8, 2, 18, 40, 0) };

    await tenantDb.withTenant(clientId, async (tx) => {
      const reserveWith = (clock: { now: () => number }) =>
        reserve({
          sql: tx,
          clientId,
          instanceId,
          isNewConversation: false,
          isGroup: false,
          gapMs: 0,
          clock,
          timeZone: 'Asia/Kolkata',
        });

      expect((await reserveWith(clockBeforeMidnightIst)).granted).toBe(true);
      expect((await reserveWith(clockBeforeMidnightIst)).granted).toBe(true);

      // First deny, bucketed to the "before midnight" IST date.
      const deniedBefore = await reserveWith(clockBeforeMidnightIst);
      expect(deniedBefore.granted).toBe(false);

      // Second deny, SAME real ledger_date (server now() barely moved), but
      // the CALLER's clock now resolves to the NEXT IST calendar date.
      const deniedAfter = await reserveWith(clockAfterMidnightIst);
      expect(deniedAfter.granted).toBe(false);
    });

    const notificationRows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notifications WHERE client_id = $1 AND kind = 'plan_cap_reached'
        ORDER BY created_at ASC`,
      [clientId],
    );
    // Two distinct dedupe buckets (one per injected-clock calendar date) -
    // never collapsed to one, even though the DB's own ledger_date never
    // changed underneath them in this test.
    expect(notificationRows.rows).toHaveLength(2);
  });
});
