import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TENANT_TABLE_COVERAGE } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchLiveGrantsForTables } from './helpers/grants.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * media-assets-schema.test.ts (P34 U-upload, ADR 0052 accepted scope) -
 * schema tests for migration 0077 (`media_assets`). Fixture-per-test tenant
 * idiom copied from `groups-schema.test.ts`'s `seedProbeTenant`.
 */
describe('media_assets_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    for (const clientId of probeClientIds) {
      await pool.query('DELETE FROM media_assets WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function seedProbeTenant(label: string): Promise<{ clientId: string }> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const slug = `media-assets-schema-${label}-${clientId}`;
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      `Media Assets Schema Probe ${label}`,
      slug,
    ]);
    probeClientIds.push(clientId);
    return { clientId };
  }

  function sha256Of(text: string): Buffer {
    return createHash('sha256').update(text).digest();
  }

  it('media_assets_is_registered_as_a_tenant_table', () => {
    expect(TENANT_TABLE_COVERAGE['media_assets']).toBe('client_id');
  });

  it('media_assets_has_row_level_security_enabled_and_forced', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'media_assets'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('media_assets_client_id_is_not_nullable', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'client_id'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
  });

  it('media_assets_client_id_sha256_has_a_unique_index', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'media_assets'
          AND indexname = 'media_assets_client_sha256_uq'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('the_same_bytes_uploaded_twice_by_one_tenant_collide_on_the_unique_index', async () => {
    const pool = await getMigratedPool();
    const tenant = await seedProbeTenant('dedupe');
    const digest = sha256Of('same-bytes-probe');

    const insertSql = `INSERT INTO media_assets
        (client_id, kind, mime_type, size_bytes, storage_key, sha256)
      VALUES ($1, 'image', 'image/png', 1024, $2, $3) RETURNING id`;

    const first = await pool.query<{ id: string }>(insertSql, [
      tenant.clientId,
      `clients/${tenant.clientId}/media/2026/09/a.png`,
      digest,
    ]);
    expect(first.rows[0]?.id).toBeDefined();

    await expect(
      pool.query(insertSql, [
        tenant.clientId,
        `clients/${tenant.clientId}/media/2026/09/b.png`,
        digest,
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23505' });
  });

  it('media_assets_rejects_a_kind_outside_the_accepted_scope_and_a_non_positive_size', async () => {
    const pool = await getMigratedPool();
    const tenant = await seedProbeTenant('checks');

    await expect(
      pool.query(
        `INSERT INTO media_assets (client_id, kind, mime_type, size_bytes, storage_key, sha256)
         VALUES ($1, 'video', 'video/mp4', 1024, $2, $3)`,
        [tenant.clientId, `clients/${tenant.clientId}/media/2026/09/x.mp4`, sha256Of('video-kind')],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    await expect(
      pool.query(
        `INSERT INTO media_assets (client_id, kind, mime_type, size_bytes, storage_key, sha256)
         VALUES ($1, 'image', 'image/png', 0, $2, $3)`,
        [tenant.clientId, `clients/${tenant.clientId}/media/2026/09/z.png`, sha256Of('zero-size')],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });
  });

  it('a_media_asset_of_another_tenant_is_invisible_under_rls', async () => {
    const pool = await getMigratedPool();
    const tenantA = await seedProbeTenant('a');
    const tenantB = await seedProbeTenant('b');

    await pool.query(
      `INSERT INTO media_assets (client_id, kind, mime_type, size_bytes, storage_key, sha256)
       VALUES ($1, 'image', 'image/png', 1024, $2, $3)`,
      [
        tenantA.clientId,
        `clients/${tenantA.clientId}/media/2026/09/a.png`,
        sha256Of('tenant-a-asset'),
      ],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await client.query("SELECT set_config('app.client_id', $1, true)", [tenantB.clientId]);

      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO media_assets (client_id, kind, mime_type, size_bytes, storage_key, sha256)
         VALUES ($1, 'document', 'application/pdf', 2048, $2, $3) RETURNING id`,
        [
          tenantB.clientId,
          `clients/${tenantB.clientId}/media/2026/09/b.pdf`,
          sha256Of('tenant-b-asset'),
        ],
      );
      expect(insertResult.rows).toHaveLength(1);

      const selectResult = await client.query<{ storage_key: string }>(
        'SELECT storage_key FROM media_assets',
      );
      expect(selectResult.rows.map((row) => row.storage_key)).toEqual([
        `clients/${tenantB.clientId}/media/2026/09/b.pdf`,
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('the_object_key_of_every_asset_starts_with_its_own_client_prefix', async () => {
    const pool = await getMigratedPool();
    const tenant = await seedProbeTenant('prefix');

    await pool.query(
      `INSERT INTO media_assets (client_id, kind, mime_type, size_bytes, storage_key, sha256)
       VALUES ($1, 'image', 'image/jpeg', 512, $2, $3)`,
      [tenant.clientId, `clients/${tenant.clientId}/media/2026/09/prefix.jpg`, sha256Of('prefix')],
    );

    const result = await pool.query<{ storage_key: string }>(
      'SELECT storage_key FROM media_assets WHERE client_id = $1',
      [tenant.clientId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.storage_key.startsWith(`clients/${tenant.clientId}/`)).toBe(true);
  });

  it('wp_scheduler_cannot_insert_or_delete_a_media_asset', async () => {
    const pool = await getMigratedPool();
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_scheduler', ['media_assets']);
    const privileges = [...new Set(tableGrants.map((row) => row.privilege_type))].sort();
    expect(privileges).toEqual(['SELECT']);

    const columnUpdateResult = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'wp_scheduler' AND table_schema = 'public' AND table_name = 'media_assets'
          AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(columnUpdateResult.rows.map((row) => row.column_name)).toEqual(['last_used_at']);
  });

  it('wp_app_grants_are_select_insert_delete_plus_column_scoped_update', async () => {
    const pool = await getMigratedPool();
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_app', ['media_assets']);
    const privileges = [...new Set(tableGrants.map((row) => row.privilege_type))].sort();
    expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT']);

    const columnUpdateResult = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'wp_app' AND table_schema = 'public' AND table_name = 'media_assets'
          AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(columnUpdateResult.rows.map((row) => row.column_name)).toEqual(['last_used_at']);
  });

  it('wp_admin_app_has_select_only_on_media_assets', async () => {
    const pool = await getMigratedPool();
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', ['media_assets']);
    expect([...new Set(tableGrants.map((row) => row.privilege_type))]).toEqual(['SELECT']);
  });
});
