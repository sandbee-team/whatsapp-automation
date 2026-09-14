import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { SUITE_A_INDEX_EXEMPTIONS } from '../src/index.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * P15 (outbox-relay-and-webhooks) Unit U1 - schema tests for migration
 * 0041_outbox_and_webhooks.sql: `outbox_events`, `webhook_endpoints`,
 * `webhook_deliveries`. No FK on any of the three (mirrors message_jobs'
 * "no FK on the hot path" precedent, migration 0007) - probe rows use fresh
 * random UUIDs with no need to seed a real `clients` row, same shape as
 * `queue-constraints.test.ts`.
 */
describe('outbox_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM webhook_deliveries WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM webhook_endpoints WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function insertOutboxEvent(params: {
    clientId: string;
    payload?: string;
    fanout?: string[];
    coalesceKey?: string | null;
  }): Promise<{ id: string }> {
    const pool = await getMigratedPool();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events
         (client_id, event_type, entity_id, payload, coalesce_key, fanout)
       VALUES ($1, 'message.sent', $2, $3, $4, $5)
       RETURNING id`,
      [
        params.clientId,
        randomUUID(),
        params.payload ?? JSON.stringify({ id: 'probe' }),
        params.coalesceKey === undefined ? null : params.coalesceKey,
        params.fanout ?? ['webhook'],
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('insertOutboxEvent: no row returned');
    return { id };
  }

  it('outbox_events_and_webhook_tables_are_covered_by_isolation_suite_a', async () => {
    const pool = await getMigratedPool();

    const NEW_TABLES = ['outbox_events', 'webhook_endpoints', 'webhook_deliveries'];

    for (const tableName of NEW_TABLES) {
      const columnResult = await pool.query<{
        is_nullable: 'YES' | 'NO';
        ordinal_position: number;
      }>(
        `SELECT is_nullable, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'client_id'`,
        [tableName],
      );
      expect(columnResult.rows, `${tableName}: client_id column exists`).toHaveLength(1);
      expect(columnResult.rows[0]?.is_nullable, `${tableName}: client_id NOT NULL`).toBe('NO');
      expect(columnResult.rows[0]?.ordinal_position, `${tableName}: client_id leads`).toBe(2);

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

    // The suite A index-exemption allow-list stays EXACTLY the three
    // pre-existing entries - none of these tables is added to it (their
    // legitimate non-client_id-leading shapes go through
    // CANONICAL_AUTHORITY_KEYS instead, same precedent as message_jobs).
    expect([...SUITE_A_INDEX_EXEMPTIONS].sort()).toEqual(
      ['campaign_recipients', 'wallet_charge_guards', 'contact_import_errors'].sort(),
    );
  });

  it('an_sse_fanned_row_without_a_coalesce_key_is_rejected', async () => {
    const clientId = randomUUID();
    probeClientIds.push(clientId);

    await expect(
      insertOutboxEvent({ clientId, fanout: ['sse'], coalesceKey: null }),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23514',
      constraint: 'outbox_events_sse_requires_coalesce_key',
    });

    // Confirm-and-record: the same fanout WITH a coalesce_key is accepted.
    await expect(
      insertOutboxEvent({ clientId, fanout: ['sse'], coalesceKey: 'probe-coalesce-key' }),
    ).resolves.toMatchObject({ id: expect.any(String) as string });

    // A webhook-only row needs no coalesce_key at all.
    await expect(
      insertOutboxEvent({ clientId, fanout: ['webhook'], coalesceKey: null }),
    ).resolves.toMatchObject({ id: expect.any(String) as string });
  });

  it('an_oversized_payload_is_rejected', async () => {
    const clientId = randomUUID();
    probeClientIds.push(clientId);

    const smallPayload = JSON.stringify({ id: 'a'.repeat(100) });
    await expect(
      insertOutboxEvent({ clientId, payload: smallPayload, coalesceKey: 'probe-key' }),
    ).resolves.toMatchObject({ id: expect.any(String) as string });

    // pg_column_size includes the jsonb varlena header, so comfortably over
    // 1024 raw bytes is enough to guarantee the stored size also exceeds it.
    const oversizedPayload = JSON.stringify({ id: 'a'.repeat(2000) });
    await expect(
      insertOutboxEvent({ clientId, payload: oversizedPayload, coalesceKey: 'probe-key' }),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23514',
      constraint: 'outbox_events_payload_size',
    });
  });

  it('webhook_deliveries_uniqueness_authority_rejects_a_duplicate_event_endpoint_pair', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    probeClientIds.push(clientId);

    const { id: outboxEventId } = await insertOutboxEvent({ clientId, coalesceKey: 'probe' });
    const endpointId = randomUUID();

    await pool.query(
      `INSERT INTO webhook_deliveries
         (client_id, outbox_event_id, endpoint_id, event_type, payload_hash)
       VALUES ($1, $2, $3, 'message.sent', $4)`,
      [clientId, outboxEventId, endpointId, Buffer.from('probe-hash')],
    );

    await expect(
      pool.query(
        `INSERT INTO webhook_deliveries
           (client_id, outbox_event_id, endpoint_id, event_type, payload_hash)
         VALUES ($1, $2, $3, 'message.sent', $4)`,
        [clientId, outboxEventId, endpointId, Buffer.from('probe-hash-2')],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23505' });
  });
});
