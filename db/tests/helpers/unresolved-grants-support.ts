import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type pg from 'pg';
import { getMigratedPool } from './migrated-db.js';

/**
 * db/tests/helpers/unresolved-grants-support.ts (P12 Unit U5a) - split out
 * of `unresolved-grants.test.ts` at the max-lines cap (topic split only, no
 * behavior change - same idiom as `session-worker-discovery-wiring.ts` /
 * `session-cost-feedback-timer.ts`). Owns the `wp_app`-role connection
 * helpers, seeding, and the two write-sequence runners that mirror
 * `unresolved.service.ts`'s actual statements; the `.test.ts` sibling owns
 * only the `it(...)` cases and their assertions. NOT itself a test file (no
 * `.test.ts` suffix - vitest's `include` glob never picks it up).
 */

export interface PgError extends Error {
  code?: string;
}

export interface Seed {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  attemptId: string;
}

export async function connectAsWpApp(pool: pg.Pool, clientId: string): Promise<pg.PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE wp_app');
  await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
  return client;
}

export async function rollbackAndRelease(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

/**
 * Runs `sql` on a FRESH `wp_app` connection and asserts it is denied with
 * `code`. A fresh connection per check is required: a permission-denied
 * error aborts its whole transaction, so a second statement reusing the
 * same connection would only ever observe 25P02 (aborted), never the real
 * per-statement check.
 */
export async function expectDenied(
  pool: pg.Pool,
  clientId: string,
  sql: string,
  params: unknown[],
  code: string,
): Promise<void> {
  const client = await connectAsWpApp(pool, clientId);
  try {
    await expect(client.query(sql, params)).rejects.toMatchObject<Partial<PgError>>({ code });
  } finally {
    await rollbackAndRelease(client);
  }
}

export async function seedJobWithAttempt(probeClientIds: string[]): Promise<Seed> {
  const pool = await getMigratedPool();
  const clientId = randomUUID();
  const instanceId = randomUUID();
  probeClientIds.push(clientId);

  const jobResult = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, 0, '15550000000@s.whatsapp.net', '+15550000000',
             '{"text":"probe"}', 'text', 'normal', 10, 'blocked_needs_review', now(), now())
     RETURNING id, created_at`,
    [clientId, instanceId],
  );
  const job = jobResult.rows[0];
  if (!job) throw new Error('seedJobWithAttempt: no message_jobs row returned');

  const attemptResult = await pool.query<{ id: string }>(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, attempt_no, state, dispatched_at)
     VALUES ($1, $2, $3, $4, 1, 'dispatched', now())
     RETURNING id`,
    [clientId, instanceId, job.id, job.created_at],
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) throw new Error('seedJobWithAttempt: no send_attempts row returned');

  return {
    clientId,
    instanceId,
    jobId: job.id,
    jobCreatedAt: job.created_at,
    attemptId: attempt.id,
  };
}

/** Runs the actual statement sequence unresolved.service.ts issues, minus the final status/reason branch. */
export async function runReplayGuardAndAttemptWrite(
  client: pg.PoolClient,
  seed: Seed,
  action: 'retry' | 'discard',
): Promise<void> {
  const keyResult = await client.query<{ action: string; inserted: boolean }>(
    `INSERT INTO unresolved_action_keys
       (client_id, idempotency_key, message_job_id, message_job_created_at, action, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, idempotency_key)
     DO UPDATE SET action = unresolved_action_keys.action
     RETURNING action, (xmax = 0) AS inserted`,
    [
      seed.clientId,
      `${action}-${randomUUID()}`,
      seed.jobId,
      seed.jobCreatedAt,
      action,
      randomUUID(),
    ],
  );
  expect(keyResult.rows[0]).toMatchObject({ action, inserted: true });

  if (action === 'retry') {
    const attemptResult = await client.query(
      `UPDATE send_attempts SET state = 'reconciled_lost', resolved_at = now()
        WHERE client_id = $1 AND message_job_id = $2 AND id = $3`,
      [seed.clientId, seed.jobId, seed.attemptId],
    );
    expect(attemptResult.rowCount).toBe(1);
  }
}

export async function runDeliveryEventAndAudit(
  client: pg.PoolClient,
  seed: Seed,
  eventType: 'queued' | 'cancelled',
): Promise<void> {
  const dedupeResult = await client.query(
    `INSERT INTO delivery_event_ids (provider_event_id, client_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_event_id) DO NOTHING`,
    [`probe-evt-${eventType}-${randomUUID()}`, seed.clientId, seed.jobId, seed.jobCreatedAt],
  );
  expect(dedupeResult.rowCount).toBe(1);

  const eventResult = await client.query(
    `INSERT INTO delivery_events
       (client_id, instance_id, message_job_id, message_job_created_at, event_type, provider_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      seed.clientId,
      seed.instanceId,
      seed.jobId,
      seed.jobCreatedAt,
      eventType,
      `probe-evt-${eventType}-${randomUUID()}`,
    ],
  );
  expect(eventResult.rowCount).toBe(1);

  const auditAction = `message.unresolved_${eventType === 'queued' ? 'retried' : 'discarded'}`;
  const auditResult = await client.query(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, 'user', $2, $3, 'message_job', $4, NULL)`,
    [seed.clientId, randomUUID(), auditAction, seed.jobId],
  );
  expect(auditResult.rowCount).toBe(1);
}
