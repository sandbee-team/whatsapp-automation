import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTenantDb } from '../src/tenant-db.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * wp-scheduler-health-writer-role.test.ts (P16 follow-up, Unit A2; extended
 * in the P16 gate-fix pass for the retention DELETE) - proves migrations
 * 0045/0046's grants actually let `wp_scheduler` perform the exact writes
 * `HealthEvaluator.ts`/`apply-band.ts`/`hard-signal-pause.ts`/`fast-lane.ts`/
 * `retention.ts` issue, under `SET LOCAL ROLE wp_scheduler` + FORCE ROW LEVEL
 * SECURITY + a real `app.client_id` tenant context - not just that a
 * `role_table_grants`/`role_column_grants` row exists (grants-snapshot.test.ts
 * already pins that). Same `SET LOCAL ROLE` + `withTenant` idiom as
 * `tenant-db.test.ts`'s own wp_app proof.
 *
 * Probe rows are seeded/cleaned up as the superuser pool (bypasses RLS) -
 * only the writes under test run as `wp_scheduler`.
 */
describe('wp_scheduler_health_writer_role', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
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
      'Health Writer Role Probe Client',
      `health-writer-role-probe-${clientId}`,
    ]);
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'health-writer-role-probe', 'connected', 0)`,
      [instanceId, clientId],
    );
    await pool.query(
      `INSERT INTO instance_pacing_state (
         instance_id, client_id, eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
         eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
         eff_window_start_local, eff_window_end_local
       ) VALUES ($1, $2, 20, 6, 8, 15000, 180000, 0.4, 5, '00:00:00', '23:59:59')`,
      [instanceId, clientId],
    );

    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  it('wp_scheduler_can_insert_instance_health_samples_under_tenant_context', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await createProbeInstance();

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_scheduler');
      await tx.query(
        `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band, evidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), clientId, instanceId, '87.50', 'healthy', JSON.stringify({})],
      );
    });

    const result = await pool.query<{ band: string }>(
      'SELECT band FROM instance_health_samples WHERE client_id = $1',
      [clientId],
    );
    expect(result.rows).toEqual([{ band: 'healthy' }]);
  });

  it('wp_scheduler_can_run_the_healthevaluator_bookkeeping_update_under_tenant_context', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await createProbeInstance();
    const dueAt = new Date();

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_scheduler');
      // Exact HealthEvaluator.ts#writeBookkeeping statement shape.
      await tx.query(
        `UPDATE instance_pacing_state SET
            last_evidence = $3,
            health_score = $4,
            health_band = $5,
            health_band_since = CASE WHEN $6::boolean THEN $7::timestamptz ELSE health_band_since END,
            eval_due_at = $8,
            updated_at = now()
          WHERE instance_id = $1 AND client_id = $2`,
        [instanceId, clientId, JSON.stringify({}), '91.00', 'healthy', true, dueAt, dueAt],
      );
    });

    const row = await pool.query<{ health_score: string; eval_due_at: Date }>(
      'SELECT health_score, eval_due_at FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.health_score).toBe('91.00');
    expect(row.rows[0]?.eval_due_at).toEqual(dueAt);
  });

  it('wp_scheduler_can_run_the_hard_signal_pause_write_set_under_tenant_context', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await createProbeInstance();

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_scheduler');

      // Exact hard-signal-pause.ts#applyHardSignalPause write set: whatsapp_instances UPDATE, instance_pacing_state UPDATE, pacing_events INSERT, audit_logs INSERT, outbox_events INSERT.
      const pauseResult = await tx.query(
        `UPDATE whatsapp_instances SET
            health_state = 'paused',
            pause_reason = $1,
            paused_at = now(),
            needs_user_action = true,
            user_action_reason = 'RESTRICTION_SIGNAL',
            updated_at = now()
          WHERE id = $2
            AND client_id = $3
            AND deleted_at IS NULL
            AND (health_state IS DISTINCT FROM 'paused' OR pause_reason IS DISTINCT FROM $1::pause_reason)
          RETURNING id`,
        ['provider_restriction', instanceId, clientId],
      );
      expect(pauseResult.rowCount).toBe(1);

      await tx.query(
        `UPDATE instance_pacing_state SET last_hard_signal_at = now()
          WHERE instance_id = $1 AND client_id = $2`,
        [instanceId, clientId],
      );

      await tx.query(
        `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, reason_codes)
         VALUES ($1, $2, $3, 'hard_signal_pause', $4, $5)`,
        [randomUUID(), clientId, instanceId, JSON.stringify({}), ['provider_restriction']],
      );

      await tx.query(
        `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'instance.paused', 'instance', $2, $3)`,
        [clientId, instanceId, JSON.stringify({ reason: 'RESTRICTION_SIGNAL' })],
      );

      await tx.query(
        `INSERT INTO outbox_events
           (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
         VALUES ($1, $2, 'instance.paused', $3, $4, $5, $6)`,
        [
          clientId,
          instanceId,
          instanceId,
          JSON.stringify({
            instanceId,
            pauseReason: 'provider_restriction',
            needsUserAction: true,
          }),
          `instance.paused:${instanceId}`,
          ['sse', 'webhook'],
        ],
      );
    });

    const instanceRow = await pool.query<{
      health_state: string;
      user_action_reason: string | null;
    }>('SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1', [
      instanceId,
    ]);
    expect(instanceRow.rows[0]).toEqual({
      health_state: 'paused',
      user_action_reason: 'RESTRICTION_SIGNAL',
    });

    const auditRow = await pool.query(
      "SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'instance.paused'",
      [clientId],
    );
    expect(auditRow.rows).toHaveLength(1);

    const outboxRow = await pool.query(
      "SELECT id FROM outbox_events WHERE client_id = $1 AND event_type = 'instance.paused'",
      [clientId],
    );
    expect(outboxRow.rows).toHaveLength(1);
  });

  it('wp_scheduler_can_run_the_health_samples_retention_delete_under_tenant_context', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await createProbeInstance();

    await pool.query(
      `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band, evidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '31 days')`,
      [randomUUID(), clientId, instanceId, '50.00', 'watch', JSON.stringify({})],
    );

    // Exact retention.ts#runHealthSamplesCleanup / health-samples-retention.sql shape - migration 0046 grants wp_scheduler DELETE (SELECT already held from 0044 covers the subquery's own created_at predicate read).
    const deletedCount = await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_scheduler');
      const result = await tx.query(
        `DELETE FROM instance_health_samples
          WHERE id IN (
            SELECT id FROM instance_health_samples
             WHERE created_at < now() - ($1 || ' milliseconds')::interval
             ORDER BY id
             LIMIT $2
          )
        RETURNING id`,
        [30 * 24 * 60 * 60 * 1000, 5000],
      );
      return result.rows.length;
    });
    expect(deletedCount).toBe(1);

    const remaining = await pool.query(
      'SELECT id FROM instance_health_samples WHERE client_id = $1',
      [clientId],
    );
    expect(remaining.rows).toHaveLength(0);
  });

  it('wp_scheduler_can_run_the_apply_band_change_eff_rewrite_under_tenant_context', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await createProbeInstance();

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_scheduler');

      // Exact config-service-warmup-write.ts#updateEffRow statement shape - the shared eff_* recompute apply-band.ts / fast-lane.ts's onSendOutcome both route through.
      const updateResult = await tx.query<{ config_version: number }>(
        `UPDATE instance_pacing_state SET eff_daily_cap = $3, eff_hourly_cap = $4, eff_new_conv_cap = $5,
                eff_gap_min_ms = $6, eff_gap_max_ms = $7, eff_cold_ratio_max = $8,
                eff_cold_ratio_floor = $9, eff_window_start_local = COALESCE($10, eff_window_start_local),
                eff_window_end_local = COALESCE($11, eff_window_end_local),
                eff_group_daily_cap = $12, config_version = config_version + 1, updated_at = now(),
                health_band = COALESCE($13, health_band),
                health_band_since = CASE WHEN $13::text IS NOT NULL AND $13::text IS DISTINCT FROM health_band
                                         THEN now() ELSE health_band_since END
          WHERE instance_id = $1 AND client_id = $2
          RETURNING config_version`,
        [instanceId, clientId, 10, 3, 4, 15000, 180000, 0.4, 5, null, null, 0, 'watch'],
      );
      expect(updateResult.rows[0]?.config_version).toBe(2);

      // The BAND_CHANGE audit_logs + pacing_events pair
      // (config-service-warmup-write.ts#insertConfigAuditAndEvent).
      await tx.query(
        `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'pacing.config.change', 'instance', $2, $3)`,
        [clientId, instanceId, JSON.stringify({ field: 'health_band' })],
      );
      await tx.query(
        `INSERT INTO pacing_events (id, client_id, instance_id, kind, from_value, to_value, reason_codes)
         VALUES ($1, $2, $3, 'BAND_CHANGE', $4, $5, $6)`,
        [
          randomUUID(),
          clientId,
          instanceId,
          JSON.stringify({ band: 'healthy' }),
          JSON.stringify({ band: 'watch' }),
          ['health_band'],
        ],
      );
    });

    const row = await pool.query<{ health_band: string; config_version: number }>(
      'SELECT health_band, config_version FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(row.rows[0]).toEqual({ health_band: 'watch', config_version: 2 });
  });
});
