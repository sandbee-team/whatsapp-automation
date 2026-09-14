import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { insertAdminRelaxOverride } from '../../modules/pacing/pacing-overrides.repo.js';
import { runOneAdminRelaxExpirySweep } from './admin-relax-expiry.js';
import { loadInstanceLayers } from './admin-relax-layers.js';
import { updatePacingConfig } from './config-service.js';

/**
 * Local probe reads/cleanup - deliberately NOT imported from
 * `modules/internal/__tests__/internal-u3b-support.ts` (a sibling module's
 * `__tests__/**`, which `no-deep-module-import` forbids reaching into; see
 * that convention documented on `internal-probe-support.ts`'s own header:
 * "an intentional per-module copy, not a cross-module import").
 */
type ProbePool = ReturnType<typeof createPool>;

interface OverrideProbeRow extends Record<string, unknown> {
  id: string;
  expiry_applied_at: Date | null;
}

async function overrideRowsFor(
  pool: ProbePool,
  clientId: string,
  instanceId: string,
): Promise<OverrideProbeRow[]> {
  const result = await pool.query<OverrideProbeRow>(
    `SELECT id::text AS id, expiry_applied_at
       FROM instance_pacing_overrides
      WHERE client_id = $1 AND instance_id = $2 ORDER BY created_at ASC`,
    [clientId, instanceId],
  );
  return result.rows;
}

async function effDailyCapFor(
  pool: ProbePool,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const result = await pool.query<{ eff_daily_cap: number }>(
    `SELECT eff_daily_cap FROM instance_pacing_state
      WHERE instance_id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`effDailyCapFor: no instance_pacing_state for ${instanceId}`);
  return row.eff_daily_cap;
}

async function cleanupProbeOverrides(pool: ProbePool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM instance_pacing_overrides WHERE client_id = ANY($1)', [clientIds]);
}

/**
 * admin-relax-expiry-c2.integration.test.ts (P28 C2 hardening) -
 * `runOneAdminRelaxExpirySweep` has no dedicated test file today (the write
 * path's own expiry is exercised only indirectly through
 * `internal-mutations-pacing.integration.test.ts`). This covers the sweep's
 * own two-row scenario: ONE expired override and ONE still-live override on
 * the SAME instance. The expired row must be re-resolved exactly once
 * (`expiry_applied_at` stamped, `expired` count 1) and - the actual hunt
 * target - the LIVE override's relaxed `eff_daily_cap` must still be the
 * value in effect afterwards. If the sweep's re-resolve folds
 * `adminOverride: undefined` (see `admin-relax-expiry.ts`'s own doc: "the
 * re-resolve is a TIGHTENING ... adminOverride: undefined") it would strip
 * BOTH rows' effect since `loadInstanceLayers` has no way to select "load
 * only the still-live override" - that is exactly the RED finding this test
 * is designed to surface if the production code drops the live override.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
const probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'admin-relax-expiry-c2-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupProbeOverrides(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('admin-relax-expiry-c2', () => {
  it('sweeping_one_expired_and_one_live_override_on_the_same_instance_resolves_the_expired_row_once_and_leaves_the_live_relax_in_effect', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = (
      await pool.query<{ id: string }>(
        `INSERT INTO staff_users (id, email, full_name, password_hash, role, status)
         VALUES (gen_random_uuid(), $1, 'C2 Probe Staff', 'x', 'superadmin', 'active')
         RETURNING id`,
        [`staff-c2-relax-${instanceId}@example.test`],
      )
    ).rows[0]!.id;

    const baselineCap = await effDailyCapFor(pool, clientId, instanceId);
    // A relaxed value comfortably under `ABSOLUTE_DAILY_CEILING` (2000, the
    // same value `seedSendTenant` already seeds `eff_daily_cap` at - see
    // that fixture's own "FINDING 6 FIX" note) but clearly distinguishable
    // from both the seeded baseline and the warm-up tier's own strict
    // `dailyCap` (20 at tier 1), so a wrongly-dropped override is visible.
    const relaxedCap = 1500;
    expect(relaxedCap).not.toBe(baselineCap);

    // Row 1: an admin_relax override that WILL be swept as expired. Applied
    // for real via `updatePacingConfig` (the same call the write path
    // makes), then its `expires_at` forced into the past directly - the
    // write path itself refuses a past expiry, so this is the only way to
    // reach an "already expired, once-live" row in a test.
    const expiredOverrideId = await insertAdminRelaxOverride(pool, {
      clientId,
      instanceId,
      patch: { dailyCap: relaxedCap },
      reason: 'c2 probe: expired override',
      actorStaffId: staffId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await tenantDb.withTenant(clientId, async (tx) => {
      const layers = await loadInstanceLayers(tx, {
        clientId,
        instanceId,
        adminOverride: {
          dailyCap: relaxedCap,
          actorUserId: staffId,
          reason: 'c2 probe: expired override',
          expiresAt: Date.now() + 60_000,
        },
      });
      await updatePacingConfig({
        sql: tx,
        clientId,
        instanceId,
        kind: 'admin_relax',
        reason: 'c2 probe: expired override applied',
        layers,
        clock: { now: () => Date.now() },
      });
    });
    await pool.query(
      `UPDATE instance_pacing_overrides SET expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [expiredOverrideId],
    );

    // Row 2: STILL LIVE admin_relax, expiring well in the future - a
    // DIFFERENT relaxed value than row 1, also applied for real, so the two
    // are unambiguous and the final `eff_daily_cap` unambiguously identifies
    // which override (if either) survived the sweep.
    const liveRelaxedCap = 1800;
    const liveOverrideId = await insertAdminRelaxOverride(pool, {
      clientId,
      instanceId,
      patch: { dailyCap: liveRelaxedCap },
      reason: 'c2 probe: still-live override',
      actorStaffId: staffId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await tenantDb.withTenant(clientId, async (tx) => {
      const layers = await loadInstanceLayers(tx, {
        clientId,
        instanceId,
        adminOverride: {
          dailyCap: liveRelaxedCap,
          actorUserId: staffId,
          reason: 'c2 probe: still-live override',
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
      });
      await updatePacingConfig({
        sql: tx,
        clientId,
        instanceId,
        kind: 'admin_relax',
        reason: 'c2 probe: still-live override applied',
        layers,
        clock: { now: () => Date.now() },
      });
    });

    // Sanity: the live override's OWN write already put `eff_daily_cap` at
    // `liveRelaxedCap` before the sweep ever runs - the sweep's job is to
    // leave it there, not to establish it.
    expect(await effDailyCapFor(pool, clientId, instanceId)).toBe(liveRelaxedCap);

    const outcome = await runOneAdminRelaxExpirySweep({
      pool,
      tenantDb,
      clock: { now: () => Date.now() },
    });

    expect(outcome.errors).toBe(0);
    expect(outcome.expired).toBeGreaterThanOrEqual(1);

    const overrides = await overrideRowsFor(pool, clientId, instanceId);
    const expiredRow = overrides.find((row) => row.id === expiredOverrideId);
    const liveRow = overrides.find((row) => row.id === liveOverrideId);
    expect(expiredRow?.expiry_applied_at).not.toBeNull();
    // The live row must NOT have been touched by the sweep - it is not yet
    // due.
    expect(liveRow?.expiry_applied_at).toBeNull();

    // THE HUNT TARGET: after the sweep, the effective pacing state must
    // still reflect the LIVE override's value, never the strict baseline
    // and never the expired row's own (different) relaxed value.
    const afterSweepCap = await effDailyCapFor(pool, clientId, instanceId);
    expect(afterSweepCap).toBe(liveRelaxedCap);
  });
});
