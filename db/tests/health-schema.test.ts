import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
}

/**
 * P16 (health-signals-and-pause) Unit A - schema tests for migration 0044:
 * instance_health_samples (new table), instance_pacing_state's three new
 * eval_* columns, and pacing_events.kind's widened CHECK. Sibling to
 * pacing-schema.test.ts (that file is already at the 300-line cap) - same
 * probe-instance idiom, split out for headroom.
 */
describe('health_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM instance_health_samples WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM pacing_events WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function createProbeInstance(): Promise<{ clientId: string; instanceId: string }> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Health Schema Probe Client',
      `health-schema-probe-${clientId}`,
    ]);
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'health-schema-probe', 'connected', 0)`,
      [instanceId, clientId],
    );

    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  it('instance_health_samples_accepts_a_valid_row_and_rejects_an_unknown_band', async () => {
    const pool = await getMigratedPool();
    const { clientId, instanceId } = await createProbeInstance();

    await pool.query(
      `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), clientId, instanceId, '87.50', 'healthy'],
    );

    const result = await pool.query<{ score: string; band: string }>(
      'SELECT score, band FROM instance_health_samples WHERE client_id = $1',
      [clientId],
    );
    expect(result.rows).toEqual([{ score: '87.50', band: 'healthy' }]);

    await expect(
      pool.query(
        `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), clientId, instanceId, '10.00', 'not_a_real_band'],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });
  });

  it('instance_health_samples_leads_with_client_id_forces_rls_and_carries_the_timeline_index', async () => {
    const pool = await getMigratedPool();

    const columnResult = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'instance_health_samples'
          AND column_name = 'client_id'`,
    );
    expect(columnResult.rows).toHaveLength(1);
    expect(columnResult.rows[0]?.is_nullable).toBe('NO');

    const rlsResult = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policy_count: number;
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_catalog.pg_policies pol
                WHERE pol.schemaname = 'public' AND pol.tablename = c.relname
                  AND pol.policyname = 'tenant_isolation') AS policy_count
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'instance_health_samples'`,
    );
    expect(rlsResult.rows).toHaveLength(1);
    expect(rlsResult.rows[0]?.relrowsecurity).toBe(true);
    expect(rlsResult.rows[0]?.relforcerowsecurity).toBe(true);
    expect(rlsResult.rows[0]?.policy_count).toBe(1);

    const indexResult = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'instance_health_samples'
          AND indexname = 'instance_health_samples_timeline_idx'`,
    );
    expect(indexResult.rows).toHaveLength(1);
    expect(indexResult.rows[0]?.indexdef).toContain('(client_id, instance_id, created_at DESC)');
  });

  it('instance_pacing_state_gains_eval_due_at_eval_tier_and_last_hard_signal_at', async () => {
    const pool = await getMigratedPool();
    const { clientId, instanceId } = await createProbeInstance();

    await pool.query(
      `INSERT INTO instance_pacing_state (
         instance_id, client_id, eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
         eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
         eff_window_start_local, eff_window_end_local
       ) VALUES ($1, $2, 20, 6, 8, 15000, 180000, 0.4, 5, '00:00:00', '23:59:59')`,
      [instanceId, clientId],
    );

    const row = await pool.query<{
      eval_due_at: Date;
      eval_tier: number;
      last_hard_signal_at: Date | null;
    }>(
      'SELECT eval_due_at, eval_tier, last_hard_signal_at FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.eval_due_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.eval_tier).toBe(2);
    expect(row.rows[0]?.last_hard_signal_at).toBeNull();

    await expect(
      pool.query('UPDATE instance_pacing_state SET eval_tier = 4 WHERE instance_id = $1', [
        instanceId,
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    const dueIndex = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'instance_pacing_state'
          AND indexname = 'instance_pacing_state_eval_due_idx'`,
    );
    expect(dueIndex.rows).toHaveLength(1);
    expect(dueIndex.rows[0]?.indexdef).toContain('(eval_due_at)');
  });

  it('pacing_events_kind_check_now_accepts_band_change_suppressed', async () => {
    const pool = await getMigratedPool();
    const { clientId, instanceId } = await createProbeInstance();

    await pool.query(
      `INSERT INTO pacing_events (id, client_id, instance_id, kind)
       VALUES ($1, $2, $3, 'BAND_CHANGE_SUPPRESSED')`,
      [randomUUID(), clientId, instanceId],
    );

    const result = await pool.query<{ kind: string }>(
      "SELECT kind FROM pacing_events WHERE client_id = $1 AND kind = 'BAND_CHANGE_SUPPRESSED'",
      [clientId],
    );
    expect(result.rows).toHaveLength(1);

    await expect(
      pool.query(
        `INSERT INTO pacing_events (id, client_id, instance_id, kind)
         VALUES ($1, $2, $3, 'NOT_A_REAL_KIND')`,
        [randomUUID(), clientId, instanceId],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });
  });
});
