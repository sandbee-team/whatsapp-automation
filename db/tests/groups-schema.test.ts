import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TENANT_TABLE_COVERAGE } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * groups-schema.test.ts (P24 groups-messaging, Unit U1) - schema tests for
 * migration 0066 (`wa_groups`) and its whatsapp_instances sync-clock columns.
 * `no_table_or_column_stores_a_group_participant_list` is the mechanical
 * refusal (ADR 0017 SS2): `wa_groups` stores COUNTS ONLY, never a
 * participant/member/admin list, ever - a comment is not a control.
 */
describe('groups_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    for (const clientId of probeClientIds) {
      await pool.query('DELETE FROM wa_groups WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM message_jobs WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function seedProbeTenant(label: string): Promise<{ clientId: string; instanceId: string }> {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const slug = `groups-schema-${label}-${clientId}`;
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      `Groups Schema Probe ${label}`,
      slug,
    ]);
    await pool.query('INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [
      instanceId,
      clientId,
      `${slug}-instance`,
    ]);
    probeClientIds.push(clientId);
    return { clientId, instanceId };
  }

  it('no_table_or_column_stores_a_group_participant_list', async () => {
    const pool = await getMigratedPool();

    const forbiddenTables = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname ~* 'participant|member'
          -- 'memberships' (client<->user workspace membership, migration
          -- 0004) is a pre-existing, unrelated identity/tenancy table, not a
          -- group-participant list - the one and only accepted exception.
          AND c.relname <> 'memberships'`,
    );
    expect(forbiddenTables.rows, JSON.stringify(forbiddenTables.rows, null, 2)).toEqual([]);

    const suspectColumns = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name ~* 'participant|member|admins?$'`,
    );
    const allowed = new Set([
      'wa_groups.participant_count',
      'wa_groups.tracked_participant_devices',
    ]);
    const unexpected = suspectColumns.rows.filter(
      (row) => !allowed.has(`${row.table_name}.${row.column_name}`),
    );
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
    expect(suspectColumns.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(
      [...allowed].sort(),
    );
    for (const row of suspectColumns.rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe('integer');
    }

    const disallowedTypeColumns = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'wa_groups'
          AND (data_type = 'jsonb' OR data_type = 'ARRAY' OR data_type = 'bytea')`,
    );
    expect(disallowedTypeColumns.rows, JSON.stringify(disallowedTypeColumns.rows, null, 2)).toEqual(
      [],
    );
  });

  it('a_group_job_may_have_a_null_recipient_e164_and_a_dm_job_may_not', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const clientId = randomUUID();
      const instanceId = randomUUID();

      async function insertMessageJob(recipientJid: string): Promise<{ id: string }> {
        const result = await client.query<{ id: string }>(
          `INSERT INTO message_jobs
             (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
              payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
           VALUES ($1, $2, 0, $3, NULL, $4, 'text', 'normal', 10, 'queued', now(), now())
           RETURNING id`,
          [clientId, instanceId, recipientJid, JSON.stringify({ text: 'probe' })],
        );
        const id = result.rows[0]?.id;
        if (id === undefined) throw new Error('insertMessageJob: no row returned');
        return { id };
      }

      await expect(insertMessageJob('120000000000001@g.us')).resolves.toMatchObject({
        id: expect.any(String) as string,
      });

      await expect(insertMessageJob('15550000000@s.whatsapp.net')).rejects.toMatchObject<
        Partial<PgError>
      >({ code: '23514', constraint: 'mj_recipient_shape' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('wa_groups_is_tenant_isolated_under_rls_force', async () => {
    const pool = await getMigratedPool();
    const tenantA = await seedProbeTenant('a');
    const tenantB = await seedProbeTenant('b');

    const groupJidA = '120000000000002@g.us';
    const groupJidB = '120000000000003@g.us';

    await pool.query(
      'INSERT INTO wa_groups (client_id, instance_id, group_jid) VALUES ($1, $2, $3)',
      [tenantA.clientId, tenantA.instanceId, groupJidA],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await client.query("SELECT set_config('app.client_id', $1, true)", [tenantB.clientId]);

      const insertResult = await client.query(
        'INSERT INTO wa_groups (client_id, instance_id, group_jid) VALUES ($1, $2, $3) RETURNING id',
        [tenantB.clientId, tenantB.instanceId, groupJidB],
      );
      expect(insertResult.rows).toHaveLength(1);

      const selectResult = await client.query('SELECT id, group_jid FROM wa_groups');
      expect(selectResult.rows.map((row: { group_jid: string }) => row.group_jid)).toEqual([
        groupJidB,
      ]);

      const updateResult = await client.query(
        `UPDATE wa_groups SET subject = 'tenant-b-attempt' WHERE group_jid = $1`,
        [groupJidA],
      );
      expect(updateResult.rowCount).toBe(0);

      // No role holds a DELETE grant on wa_groups (migration 0066: a group
      // leaving is recorded via left_at, never a row delete) - wp_app
      // therefore hits 42501 (permission denied) rather than an RLS-scoped
      // zero-row result. A bare permission-denied is a STRONGER isolation
      // guarantee than RLS here, same accepted branch as isolation-suite-a's
      // own cross-tenant probe for whatsapp_instances/campaigns.
      await client.query('SAVEPOINT probe_delete');
      try {
        await client.query('DELETE FROM wa_groups WHERE group_jid = $1', [groupJidA]);
        throw new Error('expected DELETE on wa_groups to be permission-denied for wp_app');
      } catch (err) {
        expect((err as PgError).code).toBe('42501');
        await client.query('ROLLBACK TO SAVEPOINT probe_delete');
      }

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const relRow = await pool.query<{
      relforcerowsecurity: boolean;
      policy_count: number;
    }>(
      `SELECT c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_catalog.pg_policies pol
                WHERE pol.schemaname = 'public' AND pol.tablename = c.relname
                  AND pol.policyname = 'tenant_isolation') AS policy_count
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'wa_groups'`,
    );
    expect(relRow.rows).toHaveLength(1);
    expect(relRow.rows[0]?.relforcerowsecurity).toBe(true);
    expect(relRow.rows[0]?.policy_count).toBe(1);

    expect(TENANT_TABLE_COVERAGE['wa_groups']).toBe('client_id');
  });

  it('wa_groups_shape_is_exactly_the_p24_ddl', async () => {
    const pool = await getMigratedPool();

    const columns = await pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wa_groups'
        ORDER BY ordinal_position`,
    );

    expect(columns.rows).toEqual([
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'client_id', is_nullable: 'NO' },
      { column_name: 'instance_id', is_nullable: 'NO' },
      { column_name: 'group_jid', is_nullable: 'NO' },
      { column_name: 'subject', is_nullable: 'YES' },
      { column_name: 'participant_count', is_nullable: 'YES' },
      { column_name: 'is_announce', is_nullable: 'NO' },
      { column_name: 'our_role', is_nullable: 'YES' },
      { column_name: 'joined_at', is_nullable: 'YES' },
      { column_name: 'last_synced_at', is_nullable: 'YES' },
      { column_name: 'last_message_at', is_nullable: 'YES' },
      { column_name: 'send_enabled', is_nullable: 'NO' },
      { column_name: 'send_enabled_at', is_nullable: 'YES' },
      { column_name: 'send_enabled_by_user_id', is_nullable: 'YES' },
      { column_name: 'disabled_reason', is_nullable: 'YES' },
      { column_name: 'tracked_participant_devices', is_nullable: 'NO' },
      { column_name: 'next_sync_after', is_nullable: 'YES' },
      { column_name: 'leave_requested_at', is_nullable: 'YES' },
      { column_name: 'left_at', is_nullable: 'YES' },
      { column_name: 'created_at', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' },
    ]);
  });
});
