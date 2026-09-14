import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABSOLUTE_DAILY_CEILING, ABSOLUTE_GAP_MIN_MS } from '@wp/domain';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { runOneAdminRelaxExpirySweep } from '../../engine/pacing/admin-relax-expiry.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { notificationKinds } from './__tests__/internal-probe-support.js';
import {
  cleanupU3bRows,
  forceInstanceState,
  pacingOverrideRows,
  pacingStateRow,
} from './__tests__/internal-u3b-support.js';

/**
 * internal-mutations-pacing.integration.test.ts (P28 Unit U3b, step 5) - the
 * ONE staff mutation that LOOSENS a safety control, and the sweep that walks
 * it back. Every case here asserts an EXACT clamped value (never a bound):
 * a bounds-only assertion (`<= 2000`) would be satisfied by an
 * implementation that stored the operator's raw 999999, which is precisely
 * the bug the clamp exists to prevent.
 */

const SECRET = 'internal-u3b-pacing-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-u3b-pacing-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: CIDRS,
      publishWake: () => {},
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupU3bRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

async function seedStaff(role: 'support' | 'ops' | 'superadmin' = 'superadmin'): Promise<string> {
  const id = await seedStaffUser(pool, role);
  probeStaffIds.push(id);
  return id;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function postOverride(
  instanceId: string,
  staffId: string,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  const path = `/internal/v1/instances/${instanceId}/pacing-override`;
  return app.inject({
    method: 'POST',
    url: path,
    headers: staffHeaders('POST', path, staffId),
    payload: body,
  });
}

describe('internal-mutations-pacing (P28 U3b)', () => {
  it('admin_relax_cannot_pass_the_platform_floor_or_ceiling_and_expires', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaff('superadmin');
    const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();

    const response = await postOverride(instanceId, staffId, {
      clientId,
      reason: 'temporary relax for a verified high-intent campaign window',
      expiresAt,
      patch: { dailyCap: 999_999, gapMinMs: 1 },
    });
    expect(response.statusCode).toBe(200);

    // EXACT clamped values - the platform ceiling/floor themselves, never
    // the requested 999999/1.
    expect(ABSOLUTE_DAILY_CEILING).toBe(2000);
    expect(ABSOLUTE_GAP_MIN_MS).toBe(15000);
    expect(response.json().data.appliedPatch).toEqual({ dailyCap: 2000, gapMinMs: 15000 });
    expect((response.json().data.clampedFields as string[]).sort()).toEqual([
      'dailyCap',
      'gapMinMs',
    ]);

    // The STORED row carries the clamped patch, not the requested one - an
    // operator reading it later must see what will actually apply.
    const overrides = await pacingOverrideRows(pool, clientId, instanceId);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.kind).toBe('admin_relax');
    expect(overrides[0]?.patch).toEqual({ dailyCap: 2000, gapMinMs: 15000 });
    expect(overrides[0]?.actor_staff_id).toBe(staffId);
    expect(overrides[0]?.expiry_applied_at).toBeNull();

    // And `eff_daily_cap` reads the relaxed-BUT-CLAMPED value.
    const relaxed = await pacingStateRow(pool, clientId, instanceId);
    expect(relaxed.eff_daily_cap).toBe(2000);
    expect(relaxed.eff_gap_min_ms).toBe(15000);

    expect(await notificationKinds(pool, clientId)).toEqual(['pacing_relaxed']);

    // --- the expiry sweep walks it back -------------------------------
    const overrideId = overrides[0]?.id as string;
    const pastExpiry = Date.now() + 2 * HOUR_MS;
    const first = await runOneAdminRelaxExpirySweep({
      pool,
      tenantDb,
      clock: { now: () => pastExpiry },
    });
    expect(first.errors).toBe(0);
    // Scoped to THIS probe's own row, never the sweep's fleet-wide count: a
    // parallel test file on the shared wp_test2 database may legitimately
    // contribute other rows to the same bounded scan.
    const afterExpiry = await pacingOverrideRows(pool, clientId, instanceId);
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]?.id).toBe(overrideId);
    expect(afterExpiry[0]?.expiry_applied_at).not.toBeNull();

    // The strict baseline is back: `warmupTierLayer(1)`'s own daily cap, not
    // the 2000 the relax had folded in.
    const strict = await pacingStateRow(pool, clientId, instanceId);
    expect(strict.eff_daily_cap).toBeLessThan(2000);
    const strictDailyCap = strict.eff_daily_cap;

    // A SECOND sweep is a pure no-op: the conditional
    // `expiry_applied_at IS NULL` stamp means this row is no longer selected.
    const second = await runOneAdminRelaxExpirySweep({
      pool,
      tenantDb,
      clock: { now: () => pastExpiry },
    });
    const stillStrict = await pacingStateRow(pool, clientId, instanceId);
    expect(stillStrict.eff_daily_cap).toBe(strictDailyCap);
    expect(second.errors).toBe(0);
    // Same single row, same stamp - never a second override row and never a
    // re-stamp.
    const afterSecond = await pacingOverrideRows(pool, clientId, instanceId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.expiry_applied_at).toEqual(afterExpiry[0]?.expiry_applied_at);
  });

  it('a_missing_or_out_of_range_expiry_is_a_400_and_writes_nothing', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaff('superadmin');
    const before = await pacingStateRow(pool, clientId, instanceId);

    // (a) no `expiresAt` at all - the contract requires it.
    const noExpiry = await postOverride(instanceId, staffId, {
      clientId,
      reason: 'a relax with no expiry, which must never be accepted',
      patch: { dailyCap: 500 },
    });
    expect(noExpiry.statusCode).toBe(400);

    // (b) 31 days out - past `MAX_ADMIN_RELAX_MS` (30 days).
    const tooFar = await postOverride(instanceId, staffId, {
      clientId,
      reason: 'a relax expiring further out than the platform maximum',
      expiresAt: new Date(Date.now() + 31 * DAY_MS).toISOString(),
      patch: { dailyCap: 500 },
    });
    expect(tooFar.statusCode).toBe(400);

    // (c) already in the past.
    const past = await postOverride(instanceId, staffId, {
      clientId,
      reason: 'a relax that expired before it was even requested',
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      patch: { dailyCap: 500 },
    });
    expect(past.statusCode).toBe(400);

    // Nothing landed for any of the three.
    expect(await pacingOverrideRows(pool, clientId, instanceId)).toEqual([]);
    expect((await pacingStateRow(pool, clientId, instanceId)).eff_daily_cap).toBe(
      before.eff_daily_cap,
    );
    expect(await notificationKinds(pool, clientId)).toEqual([]);
  });

  it('a_provider_restriction_paused_instance_can_never_be_relaxed', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaff('superadmin');
    const before = await pacingStateRow(pool, clientId, instanceId);

    await forceInstanceState(pool, {
      clientId,
      instanceId,
      healthState: 'paused',
      pauseReason: 'provider_restriction',
    });

    const refused = await postOverride(instanceId, staffId, {
      clientId,
      reason: 'attempting to relax pacing on a provider-restricted number',
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
      patch: { dailyCap: 500 },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('INVALID_STATE');

    // Core invariant 6: nothing loosened, nothing recorded as loosened.
    expect(await pacingOverrideRows(pool, clientId, instanceId)).toEqual([]);
    expect((await pacingStateRow(pool, clientId, instanceId)).eff_daily_cap).toBe(
      before.eff_daily_cap,
    );
    expect(await notificationKinds(pool, clientId)).toEqual([]);
  });

  it('only_a_superadmin_may_relax_pacing', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const before = await pacingStateRow(pool, clientId, instanceId);
    const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();

    for (const role of ['support', 'ops'] as const) {
      const staffId = await seedStaff(role);
      const response = await postOverride(instanceId, staffId, {
        clientId,
        reason: `a ${role} attempting a pacing relax outside its role`,
        expiresAt,
        patch: { dailyCap: 500 },
      });
      expect(response.statusCode).toBe(403);
    }

    expect(await pacingOverrideRows(pool, clientId, instanceId)).toEqual([]);
    expect((await pacingStateRow(pool, clientId, instanceId)).eff_daily_cap).toBe(
      before.eff_daily_cap,
    );
    expect(await notificationKinds(pool, clientId)).toEqual([]);
  });
});
