import { afterAll, describe, expect, it } from 'vitest';
import { SUITE_A_INDEX_EXEMPTIONS, TENANT_TABLE_COVERAGE } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P21 (inbound-listener-receipts-and-optout) Unit U1 - schema tests for
 * migration 0063 (`inbound_dead_letters.sql`): `inbound_dead_letters` (ids
 * and hashes only, no body path) and `whatsapp_instances.
 * inbound_max_per_minute`. Pure catalog/information_schema probes, no
 * business-logic writes.
 *
 * `no_chats_or_messages_table_exists_in_v1` is the mechanical v1/v2 boundary
 * (ADR 0021, phase-file scope note): the inbox product (chats, messages,
 * message bodies) is v2 work. This test is the refusal - a comment is not a
 * control. `media_assets` was ORIGINALLY on this forbidden list too (it was
 * ADR 0046's inbound-capture-media table name) - ADR 0046 is WITHDRAWN
 * (2026-09-11, ADR 0051) and the name is now legitimately claimed by ADR
 * 0052's ACCEPTED, unrelated OUTBOUND media upload pipeline (P34), so it is
 * removed from this guard rather than left to collide with an approved
 * table. The inbox boundary itself (no chats/messages/inbound bodies) is
 * unchanged.
 */
describe('inbound_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('no_chats_or_messages_table_exists_in_v1', async () => {
    const pool = await getMigratedPool();

    const forbiddenTables = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($1)`,
      [['chats', 'messages']],
    );
    expect(forbiddenTables.rows, JSON.stringify(forbiddenTables.rows, null, 2)).toEqual([]);

    const forbiddenColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND column_name = ANY($2)`,
      [
        ['inbound_dead_letters', 'whatsapp_instances'],
        ['body', 'body_tsv', 'last_message_preview', 'capture_media', 'capture_groups'],
      ],
    );
    // whatsapp_instances legitimately carries capture_groups/capture_media
    // from an earlier migration (v2 will use them; not dropped here - a
    // destructive change needs explicit user approval, database.md). The
    // v1/v2 boundary this test enforces is: inbound_dead_letters must never
    // grow ANY of these five columns, ever.
    const onDeadLetters = forbiddenColumns.rows.filter(
      (row) => row.table_name === 'inbound_dead_letters',
    );
    expect(onDeadLetters, JSON.stringify(onDeadLetters, null, 2)).toEqual([]);

    const columnOrder = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inbound_dead_letters'
        ORDER BY ordinal_position`,
    );
    expect(columnOrder.rows.map((row) => row.column_name)).toEqual([
      'id',
      'client_id',
      'instance_id',
      'wa_msg_id',
      'chat_jid_hash',
      'error_class',
      'raw_size',
      'replayed_at',
      'created_at',
    ]);
  });

  it('inbound_dead_letters_leads_with_client_id_and_is_rls_forced', async () => {
    const pool = await getMigratedPool();

    const clientIdColumn = await pool.query<{
      ordinal_position: number;
      is_nullable: 'YES' | 'NO';
    }>(
      `SELECT ordinal_position, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'inbound_dead_letters'
          AND column_name = 'client_id'`,
    );
    expect(clientIdColumn.rows).toHaveLength(1);
    expect(clientIdColumn.rows[0]?.ordinal_position).toBe(2);
    expect(clientIdColumn.rows[0]?.is_nullable).toBe('NO');

    const relRow = await pool.query<{
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
        WHERE n.nspname = 'public' AND c.relname = 'inbound_dead_letters'`,
    );
    expect(relRow.rows).toHaveLength(1);
    const row = relRow.rows[0]!;
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
    expect(row.policy_count).toBe(1);

    expect(TENANT_TABLE_COVERAGE['inbound_dead_letters']).toBe('client_id');

    expect(SUITE_A_INDEX_EXEMPTIONS.length).toBe(3);
    expect([...SUITE_A_INDEX_EXEMPTIONS]).not.toContain('inbound_dead_letters');

    // Column-narrowed grants (the UPDATE(replayed_at) below) never show up
    // in role_table_grants at all (db/tests/helpers/grants.ts precedent) -
    // this table-level check therefore only asserts the full-table
    // privileges (SELECT, INSERT); the column-scoped UPDATE is asserted
    // separately below via role_column_grants.
    const tableGrants = await pool.query<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'inbound_dead_letters'`,
    );
    const privileges = tableGrants.rows.map((r) => r.privilege_type).sort();
    expect(privileges, JSON.stringify(privileges, null, 2)).toEqual(['INSERT', 'SELECT']);

    const columnUpdateGrants = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.role_column_grants
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'inbound_dead_letters'
          AND privilege_type = 'UPDATE'`,
    );
    expect(columnUpdateGrants.rows.map((r) => r.column_name)).toEqual(['replayed_at']);

    const noDelete = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'inbound_dead_letters'
          AND privilege_type = 'DELETE'
          AND grantee != 'wp_migrator'`,
    );
    expect(noDelete.rows, JSON.stringify(noDelete.rows, null, 2)).toEqual([]);

    const instanceColumn = await pool.query<{
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'whatsapp_instances'
          AND column_name = 'inbound_max_per_minute'`,
    );
    expect(instanceColumn.rows).toHaveLength(1);
    expect(instanceColumn.rows[0]?.data_type).toBe('integer');
    expect(instanceColumn.rows[0]?.is_nullable).toBe('NO');
    expect(instanceColumn.rows[0]?.column_default).toBe('120');
  });
});
