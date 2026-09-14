import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * db/tests/reconcile-support-schema.test.ts (P12 U1) - proves
 * `db/migrations/0026_reconcile_support.sql` against the REAL database:
 * the four new columns exist with the right types, the
 * `message_wa_ids_message_id_uq` partial unique index actually ENFORCES 1:1
 * assignment (not just a catalog row - a catalog assertion would pass on an
 * index that enforces nothing), the same for `unresolved_action_keys`'
 * `(client_id, idempotency_key)` PK, and `unresolved_action_keys` carries
 * RLS ENABLE + FORCE + a `tenant_isolation` policy. Follows
 * `queue-constraints.test.ts`'s established shape (PgError interface,
 * `afterEach` cleanup by probe client id, `toMatchObject`/`rejects.
 * toMatchObject` assertions).
 */
describe('reconcile_support_schema', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM message_wa_ids WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM unresolved_action_keys WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('message_wa_ids_and_message_jobs_carry_the_four_new_columns_with_the_right_types', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: 'YES' | 'NO';
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'message_wa_ids' AND column_name IN ('content_hash', 'observed_at'))
            OR (table_name = 'message_jobs' AND column_name IN ('unresolved_reason', 'unresolved_at'))
          )`,
    );

    const byKey = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    expect(byKey.get('message_wa_ids.content_hash')).toMatchObject({
      udt_name: 'bytea',
      is_nullable: 'YES',
    });
    expect(byKey.get('message_wa_ids.observed_at')).toMatchObject({
      udt_name: 'timestamptz',
      is_nullable: 'YES',
    });
    expect(byKey.get('message_jobs.unresolved_reason')).toMatchObject({
      udt_name: 'text',
      is_nullable: 'YES',
    });
    expect(byKey.get('message_jobs.unresolved_at')).toMatchObject({
      udt_name: 'timestamptz',
      is_nullable: 'YES',
    });
  });

  it('message_jobs_needs_user_action_stays_a_not_null_boolean_unchanged', async () => {
    // Session-open correction C1 pin: this migration must NOT change the
    // column's type or nullability.
    const pool = await getMigratedPool();
    const result = await pool.query<{ udt_name: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'message_jobs'
          AND column_name = 'needs_user_action'`,
    );
    expect(result.rows[0]).toMatchObject({ udt_name: 'bool', is_nullable: 'NO' });
  });

  async function insertMessageJob(clientId: string, instanceId: string): Promise<{ id: string }> {
    const pool = await getMigratedPool();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, '15550000000@s.whatsapp.net', '+15550000000',
               '{"text":"probe"}', 'text', 'normal', 10, 'queued', now(), now())
       RETURNING id`,
      [clientId, instanceId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('insertMessageJob: no row returned');
    return { id };
  }

  it('message_wa_ids_message_id_uq_enforces_1_to_1_assignment_not_just_a_catalog_row', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const job = await insertMessageJob(clientId, instanceId);

    // Two DIFFERENT evidence rows (different wa_msg_id - the PK column), both
    // eventually assigned to the SAME message_job_id via message_id.
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at)
       VALUES ($1, $2, 'out', $3, $4, now())`,
      [clientId, instanceId, `wamid-a-${randomUUID()}`, job.id],
    );

    await expect(
      pool.query(
        `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at)
         VALUES ($1, $2, 'out', $3, $4, now())`,
        [clientId, instanceId, `wamid-b-${randomUUID()}`, job.id],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23505',
      constraint: 'message_wa_ids_message_id_uq',
    });
  });

  it('message_wa_ids_message_id_uq_does_not_block_two_unresolved_evidence_rows_with_null_message_id', async () => {
    // Confirms the index is genuinely PARTIAL (WHERE message_id IS NOT NULL)
    // - two unresolved evidence rows for the same instance must coexist.
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    await expect(
      pool.query(
        `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, content_hash, observed_at)
         VALUES ($1, $2, 'out', $3, '\\x00'::bytea, now())`,
        [clientId, instanceId, `wamid-c-${randomUUID()}`],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      pool.query(
        `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, content_hash, observed_at)
         VALUES ($1, $2, 'out', $3, '\\x00'::bytea, now())`,
        [clientId, instanceId, `wamid-d-${randomUUID()}`],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  async function insertUnresolvedActionKey(params: {
    clientId: string;
    idempotencyKey: string;
    jobId: string;
    action: 'retry' | 'discard';
    actorUserId: string;
  }): Promise<void> {
    const pool = await getMigratedPool();
    await pool.query(
      `INSERT INTO unresolved_action_keys
         (client_id, idempotency_key, message_job_id, message_job_created_at, action, actor_user_id)
       VALUES ($1, $2, $3, now(), $4, $5)`,
      [params.clientId, params.idempotencyKey, params.jobId, params.action, params.actorUserId],
    );
  }

  it('unresolved_action_keys_a_replayed_idempotency_key_raises_23505', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const actorUserId = randomUUID();
    probeClientIds.push(clientId);

    const job = await insertMessageJob(clientId, instanceId);
    const idempotencyKey = `retry-${randomUUID()}`;

    await expect(
      insertUnresolvedActionKey({
        clientId,
        idempotencyKey,
        jobId: job.id,
        action: 'retry',
        actorUserId,
      }),
    ).resolves.toBeUndefined();

    await expect(
      insertUnresolvedActionKey({
        clientId,
        idempotencyKey,
        jobId: job.id,
        action: 'retry',
        actorUserId,
      }),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23505',
      constraint: 'unresolved_action_keys_pkey',
    });
  });

  it('unresolved_action_keys_action_check_rejects_a_label_outside_retry_or_discard', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const actorUserId = randomUUID();
    probeClientIds.push(clientId);

    const job = await insertMessageJob(clientId, instanceId);

    await expect(
      insertUnresolvedActionKey({
        clientId,
        idempotencyKey: `bad-${randomUUID()}`,
        jobId: job.id,
        // @ts-expect-error - intentionally violating the CHECK constraint
        action: 'resend_once',
        actorUserId,
      }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514', constraint: 'uak_action_check' });
  });

  it('unresolved_action_keys_has_rowsecurity_forcerowsecurity_and_a_tenant_isolation_policy', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{
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
        WHERE n.nspname = 'public' AND c.relname = 'unresolved_action_keys'`,
    );

    expect(result.rows[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      policy_count: 1,
    });
  });
});
