import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError {
  code?: string;
}

/**
 * P28 (admin-internal-api-and-panel) Unit U1 - migration 0070 schema tests.
 * Real DB (`wp_test2`), one probe client + one probe staff row created and
 * deleted by this file only (never a `DELETE ... WHERE name LIKE`).
 */
describe('admin_schema_0070', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  async function withProbeClient<T>(
    fn: (pool: Awaited<ReturnType<typeof getMigratedPool>>, clientId: string) => Promise<T>,
  ): Promise<T> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    await pool.query(`INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)`, [
      clientId,
      `P28 U1 probe ${clientId}`,
      `p28-u1-probe-${clientId}`,
    ]);
    try {
      return await fn(pool, clientId);
    } finally {
      await pool.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
    }
  }

  it('staff_audit_log_idempotency_key_is_unique_and_not_null', async () => {
    const pool = await getMigratedPool();
    const staffId = randomUUID();
    const key = `p28-u1-idem-${randomUUID()}`;

    await pool.query(
      `INSERT INTO staff_audit_log (staff_id, action, reason, idempotency_key, request_hash)
       VALUES ($1, 'probe.action', 'probe reason', $2, 'h')`,
      [staffId, key],
    );
    try {
      await expect(
        pool.query(
          `INSERT INTO staff_audit_log (staff_id, action, reason, idempotency_key, request_hash)
           VALUES ($1, 'probe.action', 'probe reason', $2, 'h')`,
          [staffId, key],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await expect(
        pool.query(
          `INSERT INTO staff_audit_log (staff_id, action, reason, idempotency_key, request_hash)
           VALUES ($1, 'probe.action', 'probe reason', NULL, 'h')`,
          [staffId],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    } finally {
      await pool.query(`DELETE FROM staff_audit_log WHERE idempotency_key = $1`, [key]);
    }
  });

  it('staff_audit_log_result_is_updatable_by_wp_app_but_no_other_column_is', async () => {
    await withProbeClient(async (pool, clientId) => {
      const staffId = randomUUID();
      const key = `p28-u1-result-${randomUUID()}`;
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO staff_audit_log (staff_id, action, client_id, reason, idempotency_key, request_hash)
         VALUES ($1, 'probe.action', $2, 'probe reason', $3, 'h')
         RETURNING id`,
        [staffId, clientId, key],
      );
      const rowId = inserted.rows[0]?.id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE wp_app');
        await client.query(`SET LOCAL app.client_id = '${clientId}'`);

        await client.query(`UPDATE staff_audit_log SET result = $1 WHERE id = $2`, [
          '{"ok":true}',
          rowId,
        ]);

        await expect(
          client.query(`UPDATE staff_audit_log SET reason = 'x' WHERE id = $1`, [rowId]),
        ).rejects.toMatchObject({ code: '42501' });

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      await pool.query(`DELETE FROM staff_audit_log WHERE id = $1`, [rowId]);
    });
  });

  it('impersonation_grant_cannot_exceed_thirty_minutes', async () => {
    await withProbeClient(async (pool, clientId) => {
      const staffId = randomUUID();
      await pool.query(
        `INSERT INTO staff_users (id, email, full_name, password_hash, role)
         VALUES ($1, $2, 'Probe Staff', 'hash', 'support')`,
        [staffId, `p28-u1-staff-${staffId}@example.test`],
      );
      try {
        async function insertGrant(minutes: number, scope: string): Promise<unknown> {
          return pool.query(
            `INSERT INTO impersonation_grants
               (client_id, staff_id, scope, reason, expires_at)
             VALUES ($1, $2, $3, 'probe reason', now() + ($4 || ' minutes')::interval)`,
            [clientId, staffId, scope, String(minutes)],
          );
        }

        await expect(insertGrant(31, 'metadata_only')).rejects.toMatchObject({ code: '23514' });
        await expect(insertGrant(30, 'metadata_only')).resolves.toBeDefined();
        await expect(insertGrant(16, 'with_message_bodies')).rejects.toMatchObject({
          code: '23514',
        });
        await expect(insertGrant(15, 'with_message_bodies')).resolves.toBeDefined();
      } finally {
        await pool.query(`DELETE FROM impersonation_grants WHERE staff_id = $1`, [staffId]);
        await pool.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
      }
    });
  });

  it('plans_catalogue_has_exactly_one_default_starter_plan', async () => {
    const pool = await getMigratedPool();

    const keys = await pool.query<{ key: string | null }>(
      `SELECT key FROM plans WHERE key IN ('starter', 'growth', 'business') ORDER BY key`,
    );
    expect(keys.rows.map((r) => r.key)).toEqual(['business', 'growth', 'starter']);

    const defaults = await pool.query<{ key: string | null }>(
      `SELECT key FROM plans WHERE is_default = true`,
    );
    expect(defaults.rows).toHaveLength(1);
    expect(defaults.rows[0]?.key).toBe('starter');

    const starterLimits = await pool.query<{
      max_connected_instances: number;
      max_registered_instances: number;
      max_broadcast_recipients: number;
      max_contacts: number;
    }>(
      `SELECT pl.max_connected_instances, pl.max_registered_instances,
              pl.max_broadcast_recipients, pl.max_contacts
         FROM plan_limits pl JOIN plans p ON p.id = pl.plan_id
        WHERE p.key = 'starter'`,
    );
    expect(starterLimits.rows).toHaveLength(1);
    expect(starterLimits.rows[0]).toEqual({
      max_connected_instances: 1,
      max_registered_instances: 3,
      max_broadcast_recipients: 2000,
      max_contacts: 5000,
    });

    // `starter` is already the sole is_default=true row (asserted above), so
    // a second is_default=true insert must itself violate
    // plans_one_default_uq - proves the "exactly one default" constraint is
    // enforced at the storage layer, not just true by seed-data coincidence.
    const secondDefaultId = randomUUID();
    await expect(
      pool.query(
        `INSERT INTO plans (id, key, name, is_default) VALUES ($1, $2, 'Second default probe', true)`,
        [secondDefaultId, `p28-u1-second-default-${secondDefaultId}`],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('staff_users_email_is_unique_and_role_is_the_enum', async () => {
    const pool = await getMigratedPool();
    const staffId = randomUUID();
    const email = `p28-u1-dup-${staffId}@example.test`;

    await pool.query(
      `INSERT INTO staff_users (id, email, full_name, password_hash, role)
       VALUES ($1, $2, 'Probe Staff', 'hash', 'ops')`,
      [staffId, email],
    );
    try {
      await expect(
        pool.query(
          `INSERT INTO staff_users (id, email, full_name, password_hash, role)
           VALUES ($1, $2, 'Probe Staff Dup', 'hash', 'ops')`,
          [randomUUID(), email],
        ),
      ).rejects.toMatchObject({ code: '23505' });

      await expect(
        pool.query(
          `INSERT INTO staff_users (id, email, full_name, password_hash, role)
           VALUES ($1, $2, 'Probe Staff Bad Role', 'hash', 'not_a_role')`,
          [randomUUID(), `p28-u1-badrole-${randomUUID()}@example.test`],
        ),
      ).rejects.toMatchObject({ code: '22P02' });
    } finally {
      await pool.query(`DELETE FROM staff_users WHERE id = $1`, [staffId]);
    }
  });

  it('client_pricing_override_items_is_updatable_by_wp_app_and_not_by_wp_admin_app', async () => {
    await withProbeClient(async (pool, clientId) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE wp_app');
        await client.query(`SET LOCAL app.client_id = '${clientId}'`);
        await client.query(
          `INSERT INTO client_pricing (client_id, price_list_key, override_items)
           VALUES ($1, 'default_inr', '{}'::jsonb)
           ON CONFLICT (client_id) DO NOTHING`,
          [clientId],
        );
        await client.query(
          `UPDATE client_pricing SET override_items = '{"probe": true}'::jsonb WHERE client_id = $1`,
          [clientId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const adminClient = await pool.connect();
      try {
        await adminClient.query('BEGIN');
        await adminClient.query('SET LOCAL ROLE wp_admin_app');
        await expect(
          adminClient.query(
            `UPDATE client_pricing SET override_items = '{"probe": false}'::jsonb WHERE client_id = $1`,
            [clientId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await adminClient.query('ROLLBACK');
      } finally {
        adminClient.release();
      }

      await pool.query(`DELETE FROM client_pricing WHERE client_id = $1`, [clientId]);
    });
  });
});

export type { PgError };
