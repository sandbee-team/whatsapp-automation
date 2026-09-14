import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
}

/**
 * groups-grants.test.ts (P24 groups-messaging, Unit U3b) - split out of
 * `groups-schema.test.ts` (already at the 300-line cap) rather than grown
 * in place; topic split only, same idiom as grants-scheduler-columns.test.ts/
 * grants-snapshot-p08-instances.test.ts being split out of
 * grants-snapshot.test.ts.
 *
 * Proves migration 0068's column-scoped grant live: `wp_app` can request a
 * group sync (`groups_sync_requested_at`) but cannot move the sync clock
 * itself (`groups_next_sync_after` / `groups_last_synced_at` stay
 * wp_scheduler-owned, unchanged from migration 0066).
 */
describe('groups_grants', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    for (const clientId of probeClientIds) {
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_app_can_request_a_group_sync_but_cannot_move_the_sync_clock', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const slug = `groups-grants-${clientId}`;
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Groups Grants Probe',
      slug,
    ]);
    await pool.query('INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [
      instanceId,
      clientId,
      `${slug}-instance`,
    ]);
    probeClientIds.push(clientId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await client.query("SELECT set_config('app.client_id', $1, true)", [clientId]);

      const requestResult = await client.query(
        `UPDATE whatsapp_instances SET groups_sync_requested_at = now()
          WHERE id = $1 AND client_id = $2`,
        [instanceId, clientId],
      );
      expect(requestResult.rowCount).toBe(1);

      await client.query('SAVEPOINT probe_next_sync_after');
      try {
        await client.query(
          `UPDATE whatsapp_instances SET groups_next_sync_after = now()
            WHERE id = $1 AND client_id = $2`,
          [instanceId, clientId],
        );
        throw new Error(
          'expected UPDATE of groups_next_sync_after to be permission-denied for wp_app',
        );
      } catch (err) {
        expect((err as PgError).code).toBe('42501');
        await client.query('ROLLBACK TO SAVEPOINT probe_next_sync_after');
      }

      await client.query('SAVEPOINT probe_last_synced_at');
      try {
        await client.query(
          `UPDATE whatsapp_instances SET groups_last_synced_at = now()
            WHERE id = $1 AND client_id = $2`,
          [instanceId, clientId],
        );
        throw new Error(
          'expected UPDATE of groups_last_synced_at to be permission-denied for wp_app',
        );
      } catch (err) {
        expect((err as PgError).code).toBe('42501');
        await client.query('ROLLBACK TO SAVEPOINT probe_last_synced_at');
      }

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
