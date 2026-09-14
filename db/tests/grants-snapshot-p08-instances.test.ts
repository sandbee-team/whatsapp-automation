import { afterAll, describe, expect, it } from 'vitest';
import { getMigratedPool, closeMigratedPool } from './helpers/migrated-db.js';
import { fetchCanonicalColumnGrants } from './helpers/grants-canonical.js';

/**
 * P08 (session-lifecycle) - migration 0023. Split out of
 * `grants-snapshot.test.ts` (lint max-lines cap) so the general
 * grant-snapshot suite stays under the file's line budget; this file owns
 * exactly the wp_app/whatsapp_instances pin.
 *
 * Pins wp_app's exact whatsapp_instances grant surface (set-equality, not a
 * subset check), so a future migration cannot silently widen (or narrow) it
 * without this test catching the drift - the same "pinned exactly"
 * discipline as grants-snapshot.test.ts's wp_scheduler/message_jobs pin.
 */
describe('grants_snapshot_p08_instances', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_app_whatsapp_instances_column_grants_match_the_p08_enabling_surface_exactly', async () => {
    const pool = await getMigratedPool();
    const columnGrants = await fetchCanonicalColumnGrants(pool);

    const instanceGrants = columnGrants.filter(
      (row) => row.grantee === 'wp_app' && row.table_name === 'whatsapp_instances',
    );

    const select = instanceGrants.find((row) => row.privilege_type === 'SELECT');
    const update = instanceGrants.find((row) => row.privilege_type === 'UPDATE');
    const insert = instanceGrants.find((row) => row.privilege_type === 'INSERT');

    // Migration 0021's original epoch-only SELECT list (id, client_id,
    // session_epoch) plus migration 0023's P08 additions, plus migration
    // 0063's P21 addition (inbound_max_per_minute - the admission ceiling
    // read by modules/inbound/admission.ts), plus migration 0066's P24
    // addition (the three groups_* sync-clock columns - the panel's
    // read-only "last synced"/"sync requested" display).
    expect(select?.columns).toEqual(
      [
        'id',
        'client_id',
        'session_epoch',
        'label',
        'phone_e164',
        'owner_jid',
        'provider_kind',
        'connection_status',
        'desired_state',
        'link_state',
        'health_state',
        'needs_user_action',
        'user_action_reason',
        'qr_attempts',
        'pairing_started_at',
        'pause_reason',
        'paused_at',
        'paused_by_user_id',
        'disconnection_reason_code',
        'disconnection_reason_label',
        'disconnection_reason_at',
        'last_connected_at',
        'last_success_send_at',
        'last_error_class',
        'created_at',
        'updated_at',
        'deleted_at',
        'inbound_max_per_minute',
        'groups_next_sync_after',
        'groups_sync_requested_at',
        'groups_last_synced_at',
      ].sort(),
    );

    // Migration 0021's original epoch-only UPDATE list (session_epoch,
    // updated_at) plus migration 0023's P08 additions (deleted_at included
    // - this table's deletes are soft, via UPDATE, never a hard DELETE) plus
    // migration 0068's P24 addition (groups_sync_requested_at only - the
    // tenant-action sync-request write; groups_next_sync_after/
    // groups_last_synced_at stay worker-owned via wp_scheduler, never added
    // here).
    expect(update?.columns).toEqual(
      [
        'session_epoch',
        'updated_at',
        'desired_state',
        'link_state',
        'health_state',
        'needs_user_action',
        'user_action_reason',
        'qr_attempts',
        'pairing_started_at',
        'pause_reason',
        'paused_at',
        'paused_by_user_id',
        'disconnection_reason_code',
        'disconnection_reason_label',
        'disconnection_reason_at',
        'last_connected_at',
        'owner_jid',
        'phone_e164',
        'deleted_at',
        'groups_sync_requested_at',
      ].sort(),
    );

    // Migration 0023 ITEM 3: full-row INSERT (every existing wp_app INSERT
    // grant in this schema is full-row - no column-level INSERT precedent
    // to diverge to). role_column_grants expands a full-row grant to one
    // row per column of the table as it stands today.
    const liveColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'whatsapp_instances'`,
    );
    expect(insert?.columns).toEqual(liveColumns.rows.map((row) => row.column_name).sort());

    // Non-vacuous: exactly SELECT/UPDATE/INSERT, nothing broader (no DELETE
    // - deletes are soft via the UPDATE(deleted_at) grant above).
    expect(instanceGrants.map((row) => row.privilege_type).sort()).toEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });
});
