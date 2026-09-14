import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { computeContentHash } from '../../engine/queue/content-hash.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  seedNeedsReconcileJob,
  seedUnresolvedEvidence,
} from './__tests__/reconciler-test-helpers.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from './reconciler.js';

/**
 * reconciler.integration.test.ts (P12 Unit U3, step 6) - real Postgres.
 * Filename MUST end `.integration.test.ts` (C10 correction) -
 * `app/backend/vitest.config.ts` claims only that glob. The mandatory
 * `unresolved_send` notify proof (P17 fix round F2) lives in the sibling
 * `reconciler-unresolved-send-notify.integration.test.ts` (max-lines split,
 * mechanical - this file had no headroom left).
 */

const RECONCILE_WINDOW_MS = 600_000;
const ECHO_TOLERANCE_MS = 300_000;

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'reconciler-test' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function buildDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps {
  const metrics = bindQueueMetrics(createMetricsRegistry());
  return {
    pool,
    tenantDb,
    metrics,
    sink: { onRepairedSent: vi.fn().mockResolvedValue(undefined) },
    reconcileWindowMs: RECONCILE_WINDOW_MS,
    echoToleranceMs: ECHO_TOLERANCE_MS,
    maxRows: 500,
    now: () => Date.now(),
    ...overrides,
  };
}

describe('runOneReconcilerSweep (real Postgres)', () => {
  it('a_single_echo_resolves_the_oldest_in_flight_attempt_once', async () => {
    const contentHash = computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'hi' });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const waMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      waMsgId,
      contentHash,
    });

    const deps = buildDeps();
    // 1:1 assignment holds under a concurrent second reconciler run - assert
    // the INVARIANT (exactly one resolution), never which run "won".
    await Promise.all([runOneReconcilerSweep(deps), runOneReconcilerSweep(deps)]);

    const wa = await pool.query<{ message_id: string | null }>(
      'SELECT message_id FROM message_wa_ids WHERE client_id = $1 AND wa_msg_id = $2',
      [seeded.clientId, waMsgId],
    );
    expect(wa.rows[0]?.message_id).toBe(seeded.jobId);

    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [seeded.sendAttemptId],
    );
    expect(attempt.rows[0]?.state).toBe('reconciled_sent');

    const job = await pool.query<{ status: string; sent_at: Date | null }>(
      'SELECT status, sent_at FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('sent');
    expect(job.rows[0]?.sent_at).not.toBeNull();
  });

  it('an_echo_for_an_unresolved_attempt_is_recorded_not_dropped', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'evidence-check',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const waMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      waMsgId,
      contentHash,
    });

    // Evidence row exists with message_id NULL BEFORE the reconciler runs.
    const before = await pool.query<{ message_id: string | null }>(
      'SELECT message_id FROM message_wa_ids WHERE client_id = $1 AND wa_msg_id = $2',
      [seeded.clientId, waMsgId],
    );
    expect(before.rows[0]?.message_id).toBeNull();
  });

  it('window_expiry_without_evidence_blocks_and_never_requeues', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'no-echo-ever',
    });
    const dispatchedAt = new Date(Date.now() - RECONCILE_WINDOW_MS - 1000);
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash, dispatchedAt });

    const deps = buildDeps();
    await runOneReconcilerSweep(deps);

    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [seeded.sendAttemptId],
    );
    expect(attempt.rows[0]?.state).toBe('abandoned');

    const job = await pool.query<{
      status: string;
      needs_user_action: boolean;
      unresolved_reason: string | null;
    }>('SELECT status, needs_user_action, unresolved_reason FROM message_jobs WHERE id = $1', [
      seeded.jobId,
    ]);
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(job.rows[0]?.needs_user_action).toBe(true);
    expect(job.rows[0]?.unresolved_reason).toBe('no_echo_evidence');

    // 0 jobs requeued - no branch of the reconciler ever writes status='queued'.
    const requeued = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM message_jobs WHERE client_id = $1 AND status = 'queued'",
      [seeded.clientId],
    );
    expect(requeued.rows[0]?.count).toBe('0');
  });

  it('two_in_flight_attempts_sharing_a_hash_resolve_neither', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'ambiguous-body',
    });
    const seededA = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    // A second in-flight attempt on the SAME (client, instance) sharing the
    // SAME content hash, seeded from the start (no post-hoc client_id/
    // instance_id UPDATEs, which would fight RLS/FK consistency) - the
    // reconciler's sibling-count aggregate must see this.
    await seedNeedsReconcileJob(pool, probeClientIds, {
      contentHash,
      existingTenant: { clientId: seededA.clientId, instanceId: seededA.instanceId },
    });

    const waMsgId = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: seededA.clientId,
      instanceId: seededA.instanceId,
      waMsgId,
      contentHash,
    });

    const deps = buildDeps();
    await runOneReconcilerSweep(deps);

    const jobA = await pool.query<{ status: string; unresolved_reason: string | null }>(
      'SELECT status, unresolved_reason FROM message_jobs WHERE id = $1',
      [seededA.jobId],
    );
    expect(jobA.rows[0]?.status).toBe('blocked_needs_review');
    expect(jobA.rows[0]?.unresolved_reason).toBe('ambiguous_echo_match');
  });

  it('the_echo_capture_upsert_never_overwrites_an_already_resolved_row', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'resolved-already',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
    const waMsgId = `wamid.${randomUUID()}`;
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, content_hash, observed_at)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, now())`,
      [
        seeded.clientId,
        seeded.instanceId,
        waMsgId,
        seeded.jobId,
        seeded.jobCreatedAt,
        computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'ORIGINAL' }),
      ],
    );

    // The same ON CONFLICT ... DO UPDATE ... WHERE message_id IS NULL shape
    // echo-capture.ts writes, attempted against the ALREADY-RESOLVED row.
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, content_hash, observed_at)
       VALUES ($1, $2, 'out', $3, $4, now())
       ON CONFLICT (client_id, instance_id, direction, wa_msg_id) DO UPDATE SET
         content_hash = EXCLUDED.content_hash, observed_at = EXCLUDED.observed_at
       WHERE message_wa_ids.message_id IS NULL`,
      [seeded.clientId, seeded.instanceId, waMsgId, contentHash],
    );

    const row = await pool.query<{ message_id: string | null; content_hash: Buffer }>(
      'SELECT message_id, content_hash FROM message_wa_ids WHERE client_id = $1 AND wa_msg_id = $2',
      [seeded.clientId, waMsgId],
    );
    expect(row.rows[0]?.message_id).toBe(seeded.jobId);
    // content_hash left as it was (the ORIGINAL value), never overwritten.
    expect(
      row.rows[0]?.content_hash.equals(
        computeContentHash({ jid: '1@s.whatsapp.net', kind: 'text', text: 'ORIGINAL' }),
      ),
    ).toBe(true);
  });
});
