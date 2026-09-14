import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';

/**
 * frequency-group-pipeline.integration.test.ts (P14 Unit U6 extension) -
 * split out of `frequency.integration.test.ts` purely for that file's own
 * max-lines cap (same established split idiom as `session-worker-
 * discovery-wiring.ts`). Proves the pipeline-level group/isGroup boundary:
 * a 4th `@g.us` send is never frequency-deferred (isGroup skips that guard
 * entirely), but a `@g.us` job with a blocked word still fails (content
 * guards, never frequency, still apply to a group job).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'recipient-frequency-group-pipeline-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

async function seedGroupJob(
  pool: TestPool,
  p: { clientId: string; instanceId: string; body: string; orderIndex: number },
): Promise<{ id: string }> {
  const publicId = randomUUID();
  const groupJid = `${randomUUID().replaceAll('-', '')}@g.us`;
  const params = [
    p.clientId,
    p.instanceId,
    groupJid,
    Buffer.from(`group-freq-fixture-${String(p.orderIndex)}`),
    JSON.stringify({ text: p.body }),
    String(p.orderIndex),
  ];
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, NULL, $4, $5, 'text', 'normal', 3, 'queued', now(),
             now() + ($6 || ' milliseconds')::interval, 0, 5, false)
     RETURNING id, created_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGroupJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, p.clientId, p.instanceId, row.id, row.created_at],
  );
  return { id: row.id };
}

describe('recipient-frequency guard - pipeline level (P14 Unit U6 extension)', () => {
  it('a_group_job_skips_the_frequency_guard_but_not_the_content_guards', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });
    const claimInput = {
      instanceId,
      band: 3,
      fence: 1,
      workerId: 'group-freq-test-worker',
      claimExpiryMs: 90_000,
    };

    await pool.query(
      `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
       VALUES ($1, $2, $3, 999)`,
      [clientId, Buffer.from('group-freq-fixture-0'), new Date(claimClock.now() - 60 * 60 * 1000)],
    );
    const groupJob = await seedGroupJob(pool, {
      clientId,
      instanceId,
      body: 'Group announcement!',
      orderIndex: 0,
    });
    const groupResult = await claimAndReserveFn({ clientId, sql: pool }, claimInput);
    expect(groupResult?.id).toBe(groupJob.id);
    const groupRow = await pool.query<{ status: string; pacing_deny_reason: string | null }>(
      'SELECT status, pacing_deny_reason FROM message_jobs WHERE id = $1',
      [groupJob.id],
    );
    expect(groupRow.rows[0]?.status).toBe('processing');
    expect(groupRow.rows[0]?.pacing_deny_reason).toBeNull();

    const blockedGroupJob = await seedGroupJob(pool, {
      clientId,
      instanceId,
      body: 'Please send me the OTP right now',
      orderIndex: 1,
    });
    await claimAndReserveFn({ clientId, sql: pool }, claimInput);
    const blockedRow = await pool.query<{ status: string; last_error_class: string | null }>(
      'SELECT status, last_error_class FROM message_jobs WHERE id = $1',
      [blockedGroupJob.id],
    );
    expect(blockedRow.rows[0]).toEqual({ status: 'failed', last_error_class: 'BLOCKED_WORD' });
  });
});
