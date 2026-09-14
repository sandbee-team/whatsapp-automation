import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { cancelOptOutJobs, recordOptOut, type OptOutMirrorPort } from './registry.js';
import { restoreOptOut } from './restore.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * optout-replay-c2.integration.test.ts (P14 C2 review, replay-of-an-
 * already-applied-write lens) - three replay scenarios over the opt-out
 * registry against real Postgres:
 *   1. Restore then re-STOP: the partial unique index (`opt_outs_lookup`,
 *      `WHERE restored_at IS NULL`) must accept a NEW insert once the prior
 *      row is restored, and `cancelOptOutJobs` must re-fire against the new
 *      opt-out.
 *   2. `cancelOptOutJobs` called twice in a row: the second call cancels
 *      nothing (RETURNING empty), the first call's cancelled rows stay
 *      untouched (`attempts` unchanged).
 *   3. The pre-send precheck cancel replayed against an already-cancelled
 *      job (`pacing_refunded_at` double-refund guard) - split out to the
 *      sibling `engine/queue/dispatch-optout-precheck-replay-c2.
 *      integration.test.ts` purely for this file's own 300-line cap.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-replay-c2',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedQueuedJob(
  clientId: string,
  instanceId: string,
  phoneHash: Buffer,
): Promise<string> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550001234', $4, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [clientId, instanceId, recipientJid, phoneHash, JSON.stringify({ text: 'hello there' })],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}

describe('opt-out replay after restore (P14 C2)', () => {
  it('a_new_opt_out_row_is_insertable_after_restore_and_cancel_re_fires', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-replay-restore-hash');

    const first = await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext-1'),
          source: 'inbound_keyword',
        },
        { mirror: noopMirror },
      ),
    );
    expect(first.inserted).toBe(true);

    const rowResult = await pool.query<{ id: string }>(
      `SELECT id FROM opt_outs WHERE client_id = $1 AND phone_hash = $2 AND restored_at IS NULL`,
      [clientId, phoneHash],
    );
    const optOutId = rowResult.rows[0]?.id;
    if (!optOutId) throw new Error('expected an opt_outs row');

    // A repeat STOP while still unrestored is a no-op (idempotent insert).
    const duplicateWhileActive = await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext-1'),
          source: 'inbound_keyword',
        },
        { mirror: noopMirror },
      ),
    );
    expect(duplicateWhileActive.inserted).toBe(false);

    // Restore the opt-out (human-only path).
    const actorUserId = randomUUID();
    await tenantDb.withTenant(clientId, (tx) =>
      restoreOptOut(
        tx,
        {
          clientId,
          optOutId,
          actor: { type: 'user', userId: actorUserId },
          restoreReason: 'customer requested re-opt-in via support',
        },
        { mirror: noopMirror },
      ),
    );

    const restoredRow = await pool.query<{ restored_at: Date | null }>(
      `SELECT restored_at FROM opt_outs WHERE id = $1`,
      [optOutId],
    );
    expect(restoredRow.rows[0]?.restored_at).toBeTruthy();

    // Replay of the SAME inbound STOP after the restore: the partial unique
    // index only excludes unrestored rows, so this must succeed as a NEW
    // insert, never blocked by the now-restored row.
    const secondStop = await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext-2'),
          source: 'inbound_keyword',
        },
        { mirror: noopMirror },
      ),
    );
    expect(secondStop.inserted).toBe(true);

    const activeRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM opt_outs
        WHERE client_id = $1 AND phone_hash = $2 AND restored_at IS NULL`,
      [clientId, phoneHash],
    );
    expect(Number(activeRows.rows[0]?.count)).toBe(1);

    const allRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM opt_outs WHERE client_id = $1 AND phone_hash = $2`,
      [clientId, phoneHash],
    );
    expect(Number(allRows.rows[0]?.count)).toBe(2);

    // Cancel must re-fire against a job queued AFTER the second opt-out.
    const jobId = await seedQueuedJob(clientId, instanceId, phoneHash);
    const cancelled = await tenantDb.withTenant(clientId, (tx) =>
      cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' }),
    );
    expect(cancelled).toEqual([jobId]);
  });
});

describe('cancelOptOutJobs replayed twice (P14 C2)', () => {
  it('the_second_call_cancels_nothing_attempts_stay_untouched', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-replay-cancel-twice-hash');
    await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        { mirror: noopMirror },
      ),
    );
    const jobId = await seedQueuedJob(clientId, instanceId, phoneHash);

    const firstCall = await tenantDb.withTenant(clientId, (tx) =>
      cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' }),
    );
    expect(firstCall).toEqual([jobId]);

    const secondCall = await tenantDb.withTenant(clientId, (tx) =>
      cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' }),
    );
    expect(secondCall).toEqual([]);

    const row = await pool.query<{
      status: string;
      attempts: number;
      cancel_reason: string | null;
    }>(`SELECT status, attempts, cancel_reason FROM message_jobs WHERE id = $1`, [jobId]);
    expect(row.rows[0]?.status).toBe('cancelled');
    expect(row.rows[0]?.attempts).toBe(0);
    expect(row.rows[0]?.cancel_reason).toBe('opt_out');
  });
});
