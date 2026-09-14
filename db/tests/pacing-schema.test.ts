import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * P13 (pacing-and-warmup) Unit U1 - schema tests for migration
 * 0030/0031_pacing*.sql. Four cases (the fourth,
 * `exactly_one_table_carries_a_reserve_counter`, lives in
 * `db/tests/schema-assertions.test.ts` per this unit's dispatch, not here).
 * No probe rows needed: every case here is a catalog/information_schema
 * scan, not a data-shape assertion, so nothing to clean up in afterEach.
 */
describe('pacing_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
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

  /** Creates a probe client + whatsapp_instance pair, tracked for cleanup. */
  async function createProbeInstance(): Promise<{ clientId: string; instanceId: string }> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Pacing Schema Probe Client',
      `pacing-schema-probe-${clientId}`,
    ]);
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'pacing-schema-probe', 'connected', 0)`,
      [instanceId, clientId],
    );

    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  /** A full, IN-RANGE `instance_pacing_state` column set - each test overrides exactly the one column under test. */
  function baseRow(clientId: string, instanceId: string): Record<string, unknown> {
    return {
      instance_id: instanceId,
      client_id: clientId,
      eff_daily_cap: 20,
      eff_hourly_cap: 6,
      eff_new_conv_cap: 8,
      eff_gap_min_ms: 15000,
      eff_gap_max_ms: 180000,
      eff_cold_ratio_max: 0.4,
      eff_cold_ratio_floor: 5,
      eff_window_start_local: '00:00:00',
      eff_window_end_local: '23:59:59',
      eff_group_daily_cap: 0,
    };
  }

  async function insertRow(row: Record<string, unknown>): Promise<void> {
    const pool = await getMigratedPool();
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => `$${String(i + 1)}`).join(', ');
    await pool.query(
      `INSERT INTO instance_pacing_state (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((c) => row[c]),
    );
  }

  it('eff_columns_cannot_be_written_below_the_absolute_floors', async () => {
    const { clientId, instanceId } = await createProbeInstance();

    // eff_gap_min_ms below ABSOLUTE_GAP_MIN_MS (15000) -
    // packages/domain/src/pacing/constants.ts.
    await expect(
      insertRow({ ...baseRow(clientId, instanceId), eff_gap_min_ms: 14999 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // eff_gap_max_ms below eff_gap_min_ms.
    await expect(
      insertRow({
        ...baseRow(clientId, instanceId),
        eff_gap_min_ms: 20000,
        eff_gap_max_ms: 19999,
      }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // eff_daily_cap above ABSOLUTE_DAILY_CEILING (2000).
    await expect(
      insertRow({ ...baseRow(clientId, instanceId), eff_daily_cap: 2001 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // eff_daily_cap negative.
    await expect(
      insertRow({ ...baseRow(clientId, instanceId), eff_daily_cap: -1 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // eff_group_daily_cap above ABSOLUTE_GROUP_DAILY_CEILING (50).
    await expect(
      insertRow({ ...baseRow(clientId, instanceId), eff_group_daily_cap: 51 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // eff_group_daily_cap negative.
    await expect(
      insertRow({ ...baseRow(clientId, instanceId), eff_group_daily_cap: -1 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    // Sanity: the exact floor/ceiling values themselves are ACCEPTED (the
    // CHECKs are inclusive, never off-by-one-too-strict).
    await insertRow({
      ...baseRow(clientId, instanceId),
      eff_gap_min_ms: 15000,
      eff_gap_max_ms: 15000,
      eff_daily_cap: 2000,
      eff_group_daily_cap: 50,
    });
  });

  it('instance_pacing_state_holds_no_counter_column', async () => {
    const pool = await getMigratedPool();

    // Dual-authority regression guard: instance_pacing_state must carry NO
    // `*_count` / `consumed_*` column - the reserve counter authority is
    // pacing_ledger alone (see that migration's header, "one counter table,
    // one grantor"). A second counter-shaped column on this table would be
    // exactly the dual-authority bug class this schema exists to prevent.
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'instance_pacing_state'
          AND (column_name ILIKE '%\\_count' ESCAPE '\\' OR column_name ILIKE 'consumed\\_%' ESCAPE '\\')`,
    );

    expect(result.rows).toEqual([]);
  });

  it('every_pacing_table_leads_with_client_id_and_forces_rls', async () => {
    const pool = await getMigratedPool();

    // Exactly the six RLS-FORCE'd tenant pacing tables registered in
    // TENANT_TABLE_COVERAGE (db/src/isolation/tenant-tables.ts). No new
    // entry may be added to SUITE_A_INDEX_EXEMPTIONS or
    // ISOLATION_NON_TENANT_TABLES for any of these six.
    const tenantPacingTables = [
      'instance_pacing_state',
      'pacing_ledger',
      'client_daily_usage',
      'pacing_events',
      'instance_pacing_overrides',
      'client_limit_overrides',
    ];

    for (const tableName of tenantPacingTables) {
      const columnResult = await pool.query<{
        is_nullable: 'YES' | 'NO';
      }>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'client_id'`,
        [tableName],
      );
      expect(columnResult.rows, `${tableName}: client_id column exists`).toHaveLength(1);
      expect(columnResult.rows[0]?.is_nullable, `${tableName}: client_id NOT NULL`).toBe('NO');

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
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [tableName],
      );
      expect(rlsResult.rows, `${tableName}: exists in pg_class`).toHaveLength(1);
      const row = rlsResult.rows[0]!;
      expect(row.relrowsecurity, `${tableName}: relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${tableName}: relforcerowsecurity`).toBe(true);
      expect(row.policy_count, `${tableName}: tenant_isolation policy`).toBe(1);
    }
  });

  it('no_pacing_profile_tier_is_unlimited', async () => {
    const pool = await getMigratedPool();

    // ABSOLUTE_DAILY_CEILING hardcoded here as a literal (comment-pointed at
    // packages/domain/src/pacing/constants.ts, U2's file - does not exist
    // yet, not imported/created by this unit).
    const ABSOLUTE_DAILY_CEILING = 2000;

    const result = await pool.query<{
      profile_key: string;
      tier: number;
      daily_cap: number | null;
      hourly_cap: number | null;
      new_conv_cap: number | null;
    }>(`SELECT profile_key, tier, daily_cap, hourly_cap, new_conv_cap FROM pacing_warmup_tiers`);

    // Non-vacuous: migration 0031 must have actually seeded rows.
    expect(result.rows.length).toBeGreaterThan(0);

    for (const row of result.rows) {
      const label = `${row.profile_key} tier ${row.tier}`;
      expect(row.daily_cap, `${label}: daily_cap`).not.toBeNull();
      expect(row.hourly_cap, `${label}: hourly_cap`).not.toBeNull();
      expect(row.new_conv_cap, `${label}: new_conv_cap`).not.toBeNull();
      expect(row.daily_cap!, `${label}: daily_cap <= ceiling`).toBeLessThanOrEqual(
        ABSOLUTE_DAILY_CEILING,
      );
    }
  });

  /**
   * P14 fix round F3 findings 2/3 - pins the DELIBERATE seeded content-guard
   * threshold values so neither `db/seeds/pacing-profiles.sql` nor a future
   * "restore canon" edit can silently drift them.
   *
   * Migration 0040's Part 5 header states FALSE canon values: it claims
   * `per_recipient_7d = 8`, `dup_fanout_warn = 150`, `dup_fanout_ack = 500`
   * are canon, citing a migration-0030 CREATE TABLE comment that does not
   * exist. 0040 is APPLIED (forward-only; the migration runner checksums
   * applied files) so that header is never edited - this test is the guard
   * against a future change "restoring" those looser numbers instead. The
   * design's illustrative defaults were 150/500/8; the platform's seeded
   * values are DELIBERATELY stricter (30/60/3 for the two volume-matched
   * profiles, `conservative` stricter still on dup-fanout at 20/40). This
   * test pins the values actually seeded (migrations 0031 + 0040 Part 6,
   * mirrored by `db/seeds/pacing-profiles.sql`) - loosening any of them is
   * not a fix-round decision.
   */
  it('pins_the_deliberate_seeded_content_guard_thresholds_per_profile', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{
      key: string;
      per_recipient_24h: number;
      per_recipient_7d: number;
      dup_fanout_warn: number;
      dup_fanout_ack: number;
    }>(
      `SELECT key, per_recipient_24h, per_recipient_7d, dup_fanout_warn, dup_fanout_ack
         FROM pacing_profiles
        WHERE key IN ('conservative', 'safe_default', 'steady')
        ORDER BY key`,
    );

    expect(result.rows).toEqual([
      {
        key: 'conservative',
        per_recipient_24h: 1,
        per_recipient_7d: 3,
        dup_fanout_warn: 20,
        dup_fanout_ack: 40,
      },
      {
        key: 'safe_default',
        per_recipient_24h: 3,
        per_recipient_7d: 3,
        dup_fanout_warn: 30,
        dup_fanout_ack: 60,
      },
      {
        key: 'steady',
        per_recipient_24h: 3,
        per_recipient_7d: 3,
        dup_fanout_warn: 30,
        dup_fanout_ack: 60,
      },
    ]);
  });
});
