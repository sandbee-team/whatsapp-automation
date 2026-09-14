import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  assertNoLiveInstanceIsMissingPacingState,
  PacingProvisionMissingTierError,
  PacingStateMissingError,
  provisionInstancePacingState,
} from './provision.js';

/**
 * provision.integration.test.ts (P13 Unit U1) - real Postgres, real
 * migrated schema (migrations 0030/0031 must already be applied). Named
 * `*.integration.test.ts`, not `provision.test.ts`: every real-DB test in
 * this repo follows that convention (`.claude/rules/core-invariants.md`'s
 * mechanical-conventions section) - a plain `*.test.ts` runs under the ROOT
 * unit config with no guarantee of Postgres availability/env, and naming a
 * real-infra test that way is an explicit, binding "never" in this repo.
 *
 * The plain superuser pool (connects as `POSTGRES_USER` from
 * `.secrets/dev.env`, not `wp_app`/`wp_scheduler`) is used directly as the
 * `TenantQueryable` `provisionInstancePacingState` expects - it satisfies
 * that interface structurally (`query(sql, params?): Promise<{rows}>`) and,
 * same as every other schema/fixture test in this repo (`wallet-schema.
 * test.ts`, `modules/instances/__tests__/instances-test-helpers.ts`), is
 * not itself RLS-bound, so no `SET LOCAL ROLE`/tenant-context dance is
 * needed just to seed and assert.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-pacing-provision-tests',
});

const probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

async function seedProbeClientAndInstance(): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Pacing Provision Probe Client',
    `pacing-provision-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, 'probe')`,
    [instanceId, clientId],
  );
  probeClientIds.push(clientId);

  return { clientId, instanceId };
}

describe('provision_instance_pacing_state', () => {
  it('materialises_tier_1_eff_columns_matching_the_safe_default_tier_1_row', async () => {
    const { clientId, instanceId } = await seedProbeClientAndInstance();

    await provisionInstancePacingState(pool, { clientId, instanceId });

    const result = await pool.query<{
      profile_key: string;
      warmup_tier: number;
      eff_daily_cap: number;
      eff_hourly_cap: number;
      eff_new_conv_cap: number;
      eff_gap_min_ms: number;
      eff_gap_max_ms: number;
      eff_cold_ratio_max: string;
      eff_cold_ratio_floor: number;
      eff_window_start_local: string;
      eff_window_end_local: string;
      eff_group_daily_cap: number;
    }>(`SELECT * FROM instance_pacing_state WHERE instance_id = $1`, [instanceId]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;

    // Tier-1 safe_default row (migration 0031), verbatim.
    expect(row.profile_key).toBe('safe_default');
    expect(row.warmup_tier).toBe(1);
    expect(row.eff_daily_cap).toBe(20);
    expect(row.eff_hourly_cap).toBe(6);
    expect(row.eff_new_conv_cap).toBe(8);
    expect(row.eff_gap_min_ms).toBe(45000);
    expect(row.eff_gap_max_ms).toBe(180000);
    expect(Number(row.eff_cold_ratio_max)).toBeCloseTo(0.4, 5);
    expect(row.eff_group_daily_cap).toBe(0);
    // Profile-level window/floor (safe_default: migration 0031).
    expect(row.eff_cold_ratio_floor).toBe(5);
    expect(row.eff_window_start_local).toBe('08:00:00');
    expect(row.eff_window_end_local).toBe('20:00:00');
  });

  it('throws_pacing_provision_missing_tier_error_for_an_unknown_profile_key', async () => {
    const { clientId, instanceId } = await seedProbeClientAndInstance();

    await expect(
      provisionInstancePacingState(pool, {
        clientId,
        instanceId,
        profileKey: 'does-not-exist',
      }),
    ).rejects.toThrow(PacingProvisionMissingTierError);
  });

  // All three boot-assertion cases below scope the scan to their own probe
  // instance id: the shared dev database carries pre-existing fixture
  // instances (db/seeds/queue-explain-fixture.sql) with no pacing state,
  // which is ambient state a deterministic test must never sample (see
  // assertNoLiveInstanceIsMissingPacingState's own doc comment).

  it('boot_assertion_fails_for_a_live_instance_with_no_pacing_state_row', async () => {
    const { instanceId } = await seedProbeClientAndInstance();
    // Deliberately NOT provisioned - the boot assertion must catch this.

    await expect(assertNoLiveInstanceIsMissingPacingState(pool, [instanceId])).rejects.toThrow(
      PacingStateMissingError,
    );

    const err = await assertNoLiveInstanceIsMissingPacingState(pool, [instanceId]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PacingStateMissingError);
    expect((err as Error).message).toContain(instanceId);
  });

  it('boot_assertion_passes_once_every_live_instance_is_provisioned', async () => {
    const { clientId, instanceId } = await seedProbeClientAndInstance();
    await provisionInstancePacingState(pool, { clientId, instanceId });

    await expect(
      assertNoLiveInstanceIsMissingPacingState(pool, [instanceId]),
    ).resolves.toBeUndefined();
  });

  it('boot_assertion_ignores_a_soft_deleted_instance_with_no_pacing_state_row', async () => {
    const { clientId, instanceId } = await seedProbeClientAndInstance();
    await pool.query('UPDATE whatsapp_instances SET deleted_at = now() WHERE id = $1', [
      instanceId,
    ]);
    void clientId;

    await expect(
      assertNoLiveInstanceIsMissingPacingState(pool, [instanceId]),
    ).resolves.toBeUndefined();
  });
});
