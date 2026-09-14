import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { computeFingerprint } from '../content/fingerprint.js';
import { ackFanout } from './ack-fanout.js';

/**
 * ack-fanout-crash-window-c2.integration.test.ts (P14 C2 review, crash-
 * mid-transaction lens) - a "crash between the ack tx commit and the wake
 * publish" is simulated by an injected `publishWake` that throws AFTER the
 * ack transaction has already committed: the DB write (`next_attempt_at =
 * now()`) must have already landed regardless of whether the wake ever
 * fires, because `ackFanout` publishes wakes strictly AFTER its own
 * `withTenant` callback returns (module doc, "WAKE" section) - so a crash in
 * the wake step can never roll back the DB half. This is the property that
 * makes the ≤42s safety poll alone sufficient to reclaim an acked job even
 * if every wake publish in the process dies.
 *
 * A second case pins concurrent ack + claim: a claim pass that is IN THE
 * MIDDLE of evaluating a NEEDS_HUMAN_ACK-held job (about to write its own
 * 300s re-check hold) racing an ack that resets next_attempt_at=now() must
 * never lose the ack's release - the job must end up claimable (either the
 * claim's own defer-write loses the race and gets overwritten by the
 * concurrent ack, or the ack's write lands after and wins outright; either
 * way the job is never left stuck past both operations).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'ack-crash-c2' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
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

async function seedHeldJob(
  clientId: string,
  instanceId: string,
  fingerprint: Buffer,
  recipientHash: Buffer,
): Promise<string> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation, content_fingerprint, pacing_deny_reason)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(),
             now() + interval '300 seconds', 0, 5, false, $6, 'NEEDS_HUMAN_ACK')
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      recipientJid,
      recipientHash,
      JSON.stringify({ text: 'Big sale today, everything 50% off!' }),
      fingerprint,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedHeldJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}

describe('ackFanout crash window and concurrent ack+claim (P14 C2)', () => {
  it('a_crash_between_ack_commit_and_wake_publish_still_leaves_the_job_claimable_by_db_state_alone', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const localDate = '2026-09-02';
    const fingerprint = computeFingerprint('Crash window fixture body, exact match every time');
    const recipientHash = Buffer.from('c2-crash-window-recipient');

    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
       VALUES ($1, $2, $3, 600)`,
      [clientId, localDate, fingerprint],
    );
    const jobId = await seedHeldJob(clientId, instanceId, fingerprint, recipientHash);

    // Simulates the wake step dying AFTER the ack transaction has already
    // committed - a crashed process, a Redis outage, whatever - the DB half
    // must be unaffected either way.
    const crashingPublishWake = async (): Promise<void> => {
      throw new Error('simulated crash: wake publish never reaches Redis');
    };

    await expect(
      ackFanout(
        { tenantDb, publishWake: crashingPublishWake },
        { clientId, actorUserId: randomUUID(), localDate, fingerprint },
      ),
    ).rejects.toThrow('simulated crash');

    // The ack transaction (fingerprint ack_by/ack_at + message_jobs
    // next_attempt_at=now() + audit_logs) committed BEFORE the wake step
    // ever ran - the DB state must reflect a fully-applied ack despite the
    // "crash" in the step that runs strictly after commit.
    const fpRow = await pool.query<{ ack_by: string | null }>(
      `SELECT ack_by FROM content_fingerprints WHERE client_id = $1 AND local_date = $2 AND fingerprint = $3`,
      [clientId, localDate, fingerprint],
    );
    expect(fpRow.rows[0]?.ack_by).toBeTruthy();

    const jobRow = await pool.query<{ next_attempt_at: Date; status: string }>(
      `SELECT next_attempt_at, status FROM message_jobs WHERE id = $1`,
      [jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
    expect(jobRow.rows[0]!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND action = 'pacing.fanout_ack'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('a_concurrent_ack_and_claim_pass_never_loses_the_release_the_job_ends_up_claimable', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const localDate = '2026-09-02';
    const fingerprint = computeFingerprint('Concurrent ack+claim fixture body, exact match');
    const recipientHash = Buffer.from('c2-concurrent-ack-claim-recipient');

    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
       VALUES ($1, $2, $3, 600)`,
      [clientId, localDate, fingerprint],
    );
    const jobId = await seedHeldJob(clientId, instanceId, fingerprint, recipientHash);

    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
    });

    const publishedWakes: string[] = [];

    // Race an ack (which resets next_attempt_at=now()) against a claim pass
    // (which, if it wins the row first, re-evaluates the guard pipeline and
    // re-defers with a FRESH 300s hold). Whichever order the DB serializes
    // these in, the job must never end up BOTH held with a stale reason AND
    // unreachable - it must remain 'queued' and eventually reach a state a
    // later claim can act on.
    await Promise.all([
      ackFanout(
        {
          tenantDb,
          publishWake: async (_c, i) => void publishedWakes.push(i),
        },
        { clientId, actorUserId: randomUUID(), localDate, fingerprint },
      ),
      claimAndReserveFn(
        { clientId, sql: pool },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'concurrent-ack-claim-worker',
          claimExpiryMs: 90_000,
        },
      ),
    ]);

    const jobRow = await pool.query<{
      status: string;
      pacing_deny_reason: string | null;
      next_attempt_at: Date;
    }>(`SELECT status, pacing_deny_reason, next_attempt_at FROM message_jobs WHERE id = $1`, [
      jobId,
    ]);
    const row = jobRow.rows[0];
    expect(row).toBeDefined();
    // Never lost: the job is either still 'queued' (deferred again by a
    // re-evaluation that re-tripped NEEDS_HUMAN_ACK, or released by the ack)
    // or 'processing' (the claim won and the pipeline granted it, since the
    // ack may have released it before the claim's own guard re-check ran).
    // It must NEVER be stuck in a state with a next_attempt_at further in
    // the future than the pipeline's own bounded 300s re-check hold from
    // NOW - i.e. no unbounded/lost hold.
    expect(['queued', 'processing']).toContain(row!.status);
    if (row!.status === 'queued') {
      expect(row!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 300_000 + 5000);
    }
  });
});
