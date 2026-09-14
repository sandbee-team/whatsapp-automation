import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

type TestPool = ReturnType<typeof createPool>;

/**
 * card-test-fixtures.ts (P17 Unit U4, step 7) - seed helpers split out of
 * `card.integration.test.ts` for max-lines discipline (same split idiom as
 * `session-worker-discovery-wiring.ts`), not a behavioural boundary. NOT
 * itself a test file (no `.test.ts` suffix).
 */

export async function seedQueuedJobs(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  count: number,
  createdAtOverrides?: (i: number) => Date,
): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (let i = 0; i < count; i += 1) {
    const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
    const createdAt = createdAtOverrides ? createdAtOverrides(i) : new Date();
    values.push(
      `($${p++}, $${p++}, 0, $${p++}, '+15550000000', $${p++}, $${p++}, 'text', 'normal', 3, 'queued', $${p++}, now(), 0, 5, false)`,
    );
    params.push(
      clientId,
      instanceId,
      recipientJid,
      Buffer.from(`card-recipient-${randomUUID()}`),
      JSON.stringify({ text: 'hello' }),
      createdAt,
    );
  }
  await pool.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, created_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ${values.join(',')}`,
    params,
  );
}

/** `message_jobs_queued_probe_idx` is the PARENT partial index (migration 0050, replacing 0049's client_id-less `message_jobs_queued_created_idx`) - Postgres auto-generates one CHILD index per partition with its own derived name, never the literal parent string (same documented behavior as `db/tests/claim-plan.test.ts`'s own `fetchClaimIndexChildNames`). */
export async function fetchQueuedCreatedIndexChildNames(pool: TestPool): Promise<string[]> {
  const result = await pool.query<{ child_index_name: string }>(
    `SELECT ic.relname AS child_index_name
       FROM pg_catalog.pg_inherits inh
       JOIN pg_catalog.pg_class ic ON ic.oid = inh.inhrelid
      WHERE inh.inhparent = 'message_jobs_queued_probe_idx'::regclass
      ORDER BY ic.relname`,
  );
  return result.rows.map((row) => row.child_index_name);
}

/** Seeds `count` `sent` (non-queued) rows, newer than any queued row, so `message_jobs_recent_idx`'s backward-scan-with-filter path (migration 0049's own header) has many non-matching rows to walk past before it could satisfy a MIN(created_at) over the queued subset - forcing a real cost-based preference for the new partial index over that competing plan. */
export async function seedSentNoiseJobs(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (let i = 0; i < count; i += 1) {
    const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
    values.push(
      `($${p++}, $${p++}, 0, $${p++}, '+15550000000', $${p++}, $${p++}, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, false, now())`,
    );
    params.push(
      clientId,
      instanceId,
      recipientJid,
      Buffer.from(`card-noise-recipient-${randomUUID()}`),
      JSON.stringify({ text: 'noise' }),
    );
  }
  await pool.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, created_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation, sent_at)
     VALUES ${values.join(',')}`,
    params,
  );
}

/**
 * Seeds `otherInstanceCount` OTHER instances (same client, same partition)
 * with `jobsEach` queued rows apiece - same "no single instance dominates
 * the partition" shape `db/tests/claim-plan.test.ts`'s own
 * `seedPlanRepresentativeFixture` fixture uses (15 instances x 300 jobs),
 * scaled here since this file only needs the PLANNER'S per-instance
 * selectivity estimate to stay realistic, not a full claim-path stress
 * fixture. Without enough noise, a single instance's 10,500 rows can BE
 * (near 100% of) the partition, and a Seq Scan becomes the genuinely
 * cheaper plan - not a defect in `instance-card-queue-depth.sql`, just an
 * unrealistic single-tenant fixture shape. The caller must pass a
 * (count, jobsEach) large enough that the probed instance's rows are a
 * SELECTIVE fraction of the partition (measured empirically at 40 x 3000
 * = ~8% selectivity for a 10,500-row probe - confirmed to flip the plan
 * to a Bitmap Heap Scan; 2026-09-05 partition rollover, see
 * `.memory/lessons/2026-09-05-partition-rollover-broke-a-plan-shape-assertion.md`).
 */
export async function seedOtherInstanceNoise(
  pool: TestPool,
  clientId: string,
  otherInstanceCount: number,
  jobsEach: number,
): Promise<void> {
  for (let n = 0; n < otherInstanceCount; n += 1) {
    const otherInstanceId = randomUUID();
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'card-noise-instance', 'connected', 0)`,
      [otherInstanceId, clientId],
    );
    await pool.query(
      'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, 1)',
      [otherInstanceId, clientId],
    );
    await seedQueuedJobs(pool, clientId, otherInstanceId, jobsEach);
  }
}
