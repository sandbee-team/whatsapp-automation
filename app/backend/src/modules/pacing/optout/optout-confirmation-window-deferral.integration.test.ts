import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { reserve } from '../../../engine/pacing/index.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';

/**
 * optout-confirmation-window-deferral.integration.test.ts (P14 Unit U4,
 * step 7, [R-3s]; extended P14 review-fix F2, Finding 6) - split out of
 * `registry-optout-enforcement.integration.test.ts` purely for that file's
 * max-lines cap (same established split idiom used throughout this phase).
 * Proves the exempt reserve (`sendOrigin: 'opt_out_confirmation'`) still
 * DENIES with OUTSIDE_WINDOW outside the instance's sending window, and
 * GRANTS (consuming `system_count`, never `consumed_count`) once the window
 * opens - `reserve-pacing.sql`'s point (11): exemption is from pacing, never
 * from the sending window.
 *
 * FINDING 6: an exempt deny INSIDE the window with an exhausted plan cap
 * must report PLAN_CAP, never MIN_GAP (or any other bypassed predicate) -
 * `pacing-deny-reason.sql`'s exempt ladder checks only OUTSIDE_WINDOW then
 * PLAN_CAP, mirroring `reserve-pacing.sql`'s own exempt bypass exactly.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-confirmation-window-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM client_limit_overrides WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('an exempt opt-out confirmation reserve still respects the sending window (real Postgres)', () => {
  it('an_optout_confirmation_at_0300_defers_to_window_open', async () => {
    // A one-second-wide window makes "now" outside it for virtually every
    // real instant, deterministically - the same fixturing mechanism
    // reserve-clock.integration.test.ts's own suite uses
    // (seedPacingInstance's caller-overridable eff_window_start_local/
    // eff_window_end_local), never a fake clock (reserve-pacing.sql has no
    // injectable clock).
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      windowStartLocal: '00:00:00',
      windowEndLocal: '00:00:01',
    });

    const denied = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: { now: () => Date.now() },
      timeZone: 'UTC',
      sendOrigin: 'opt_out_confirmation',
      windowStartLocal: '00:00:00',
      windowEndLocal: '00:00:01',
    });
    expect(denied.granted).toBe(false);
    if (!denied.granted) {
      expect(denied.reason).toBe('OUTSIDE_WINDOW');
    }
    const ledgerAfterDeny = await pool.query<{ consumed_count: number; system_count: number }>(
      'SELECT consumed_count, system_count FROM pacing_ledger WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    expect(ledgerAfterDeny.rows[0]).toEqual({ consumed_count: 0, system_count: 0 });

    // Open the window wide - the SAME exempt reserve now grants.
    await pool.query(
      `UPDATE instance_pacing_state SET eff_window_start_local = '00:00:00', eff_window_end_local = '23:59:59'
        WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    const granted = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: { now: () => Date.now() },
      timeZone: 'UTC',
      sendOrigin: 'opt_out_confirmation',
      windowStartLocal: '00:00:00',
      windowEndLocal: '23:59:59',
    });
    expect(granted.granted).toBe(true);
    const ledgerAfterGrant = await pool.query<{ consumed_count: number; system_count: number }>(
      'SELECT consumed_count, system_count FROM pacing_ledger WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    expect(ledgerAfterGrant.rows[0]).toEqual({ consumed_count: 0, system_count: 1 });
  });

  it('an_exempt_deny_inside_the_window_with_an_exhausted_plan_cap_reports_plan_cap_not_min_gap', async () => {
    // Finding 6: window is wide open (never denies OUTSIDE_WINDOW), and
    // every OTHER pacing predicate an exempt reserve would normally bypass
    // (MIN_GAP included - eff_gap_min_ms/eff_gap_max_ms below force a
    // massive gap) is deliberately left in a state that WOULD deny a
    // non-exempt reserve at MIN_GAP, proving the exempt ladder in
    // pacing-deny-reason.sql never reaches that predicate. The plan cap
    // (client_limit_overrides.max_daily_sends = 0) is the ONLY predicate an
    // exempt reserve still respects - the resulting deny must report
    // PLAN_CAP, never MIN_GAP and never UNKNOWN.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      windowStartLocal: '00:00:00',
      windowEndLocal: '23:59:59',
      gapMinMs: 3_600_000,
      gapMaxMs: 3_600_000,
    });
    await pool.query(
      `INSERT INTO client_limit_overrides (client_id, limit_key, limit_value, reason)
       VALUES ($1, 'max_daily_sends', 0, 'Finding 6 exempt plan-cap test')`,
      [clientId],
    );

    // MUST run tenant-scoped - effective_client_limits reads clients under
    // RLS FORCE (see reserve-plan-cap.integration.test.ts's own note).
    await tenantDb.withTenant(clientId, async (tx) => {
      const denied = await reserve({
        sql: tx,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 3_600_000,
        clock: { now: () => Date.now() },
        timeZone: 'UTC',
        sendOrigin: 'opt_out_confirmation',
        windowStartLocal: '00:00:00',
        windowEndLocal: '23:59:59',
      });
      expect(denied.granted).toBe(false);
      if (!denied.granted) {
        expect(denied.reason).toBe('PLAN_CAP');
      }
    });

    const ledger = await pool.query<{ consumed_count: number; system_count: number }>(
      'SELECT consumed_count, system_count FROM pacing_ledger WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    // A genuine deny never consumes either counter.
    expect(ledger.rows[0]).toEqual({ consumed_count: 0, system_count: 0 });
  });
});
