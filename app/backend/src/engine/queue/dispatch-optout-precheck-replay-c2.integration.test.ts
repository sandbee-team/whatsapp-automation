import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-tenant-fixture.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';
import {
  runOptOutPrecheck,
  refundPacingUnitAfterPrecheckCancel,
} from './dispatch-optout-precheck.js';
import { recordOptOut, type OptOutMirrorPort } from '../../modules/pacing/optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * dispatch-optout-precheck-replay-c2.integration.test.ts (P14 C2 review,
 * replay-of-an-already-applied-write lens) - split out of the sibling
 * `modules/pacing/optout/optout-replay-c2.integration.test.ts` purely for
 * that file's own 300-line cap (same established split idiom as
 * `session-worker-discovery-wiring.ts`). Replays the pre-send precheck
 * cancel against an already-cancelled job: the second call must match zero
 * rows (the lease-guarded WHERE no longer matches `status='processing'`),
 * and the pacing refund must never double-fire even when the refund helper
 * itself is invoked twice for the same job (`release-pacing.sql`'s own
 * `pacing_refunded_at IS NULL` guard, exercised end-to-end here).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'precheck-replay-c2',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
    // The guard pipeline (evaluateGuards, run inside claimAndReserve for
    // every text-body job) always writes a content_fingerprint_recipients
    // row (and upserts content_fingerprints) regardless of this file's own
    // focus - both must be cleaned up before cleanupSendProbeClients's own
    // `DELETE FROM clients` or the FK from content_fingerprints.client_id
    // blocks it.
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

describe('pre-send precheck cancel replayed against an already-cancelled job (P14 C2)', () => {
  it('the_second_precheck_call_matches_zero_rows_and_the_refund_never_double_fires', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-replay-precheck-hash');

    // Seed a job already claimed (processing) with a real pacing reserve, so
    // the refund path has something real to refund.
    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
    });
    const publicId = randomUUID();
    const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
    const inserted = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, is_new_conversation)
       VALUES ($1, $2, 0, $3, '+15550005678', $4, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
       RETURNING id, created_at`,
      [clientId, instanceId, recipientJid, phoneHash, JSON.stringify({ text: 'order update' })],
    );
    const jobRow = inserted.rows[0];
    if (!jobRow) throw new Error('expected inserted job row');
    await pool.query(
      `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [publicId, clientId, instanceId, jobRow.id, jobRow.created_at],
    );

    const claimed = await claimAndReserveFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'precheck-replay-worker', claimExpiryMs: 90_000 },
    );
    expect(claimed?.id).toBe(jobRow.id);
    expect(claimed?.pacingReserve).toBeDefined();

    // Opt-out arrives AFTER the claim (a stale-cache worker scenario).
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

    const precheckInput = {
      clientId,
      instanceId,
      jobId: jobRow.id,
      leaseId: claimed!.leaseId,
      recipientJid,
      recipientHash: phoneHash,
      sendOrigin: 'api_send',
    };

    // FIRST precheck: cancels the job under the still-held lease.
    const firstPrecheck = await tenantDb.withTenant(clientId, (tx) =>
      runOptOutPrecheck(tx, {}, precheckInput),
    );
    expect(firstPrecheck.cancelled).toBe(true);

    await refundPacingUnitAfterPrecheckCancel(
      tenantDb,
      { clientId, instanceId, jobId: jobRow.id },
      claimed!.pacingReserve,
    );

    const afterFirstRefund = await pool.query<{ pacing_refunded_at: Date | null }>(
      `SELECT pacing_refunded_at FROM message_jobs WHERE id = $1`,
      [jobRow.id],
    );
    expect(afterFirstRefund.rows[0]?.pacing_refunded_at).toBeTruthy();
    const firstRefundedAt = afterFirstRefund.rows[0]!.pacing_refunded_at;

    // REPLAY: a retried dispatch attempt runs the precheck again against the
    // SAME (now already-cancelled, lease fields untouched by the precheck
    // cancel itself, only status/cancel_reason/pacing_deny_reason/
    // terminal_at) job. The lease-guarded WHERE (`status='processing'`) now
    // matches ZERO rows because status is already 'cancelled' - this must
    // be a clean no-op, never a second cancellation or an error.
    const secondPrecheck = await tenantDb.withTenant(clientId, (tx) =>
      runOptOutPrecheck(tx, {}, precheckInput),
    );
    expect(secondPrecheck.cancelled).toBe(false);

    // Replay the refund too - release()'s own pacing_refunded_at guard must
    // make this a no-op, never a second refund of the same ledger unit.
    await refundPacingUnitAfterPrecheckCancel(
      tenantDb,
      { clientId, instanceId, jobId: jobRow.id },
      claimed!.pacingReserve,
    );

    const afterSecondRefund = await pool.query<{
      pacing_refunded_at: Date | null;
      status: string;
    }>(`SELECT pacing_refunded_at, status FROM message_jobs WHERE id = $1`, [jobRow.id]);
    expect(afterSecondRefund.rows[0]?.status).toBe('cancelled');
    // Byte-identical refund timestamp - the second call never re-stamped it.
    expect(afterSecondRefund.rows[0]?.pacing_refunded_at?.getTime()).toBe(
      firstRefundedAt?.getTime(),
    );

    const ledger = await pool.query<{ consumed_count: number; refund_count: number }>(
      `SELECT consumed_count, refund_count FROM pacing_ledger WHERE instance_id = $1`,
      [instanceId],
    );
    // Exactly one unit consumed net-of-refund (the original grant then the
    // first precheck's refund brought it back to 0) and exactly one refund
    // recorded (the first precheck cancel) - never two refunds for one
    // consumed unit.
    expect(ledger.rows[0]?.consumed_count).toBe(0);
    expect(ledger.rows[0]?.refund_count).toBe(1);
  });
});
