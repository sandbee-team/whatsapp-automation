import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { computeContentHash } from '../../engine/queue/content-hash.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import { notify } from '../notifications/index.js';
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
 * reconciler-unresolved-send-notify.integration.test.ts (P17 fix round F2,
 * corrected after coordinator review) - sibling split of
 * reconciler.integration.test.ts (max-lines cap, mechanical extraction).
 * Proves the mandatory `unresolved_send` notify:
 *   (i)   exactly one per job on the ambiguous branch, and still exactly one
 *         after a second sweep (dedupe via `transitionId = message_job_id`);
 *   (ii)  the notify() call shares `applyAmbiguous`'s own transaction - a
 *         rollback of that transaction (for ANY reason) leaves ZERO
 *         notification rows, never an orphan (this is the exact invariant
 *         the phase spec names: "notify() outside the transaction is a
 *         lost-or-duplicated alert"). Proven using the reconciler's own
 *         UPDATE statement text + the real `notify()` call inside one
 *         `withTenant` transaction, forced to roll back;
 *   (iii) a notify() failure inside the SAME transaction (forced via a real
 *         FK violation - the instance row deleted between seed and sweep)
 *         still lets the blocked_needs_review write commit (fail-safe
 *         layering, F5's own swallow-and-log guard).
 */

const RECONCILE_WINDOW_MS = 600_000;
const ECHO_TOLERANCE_MS = 300_000;

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reconciler-notify-test',
  });
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

interface NotificationCountRow extends Record<string, unknown> {
  count: string;
}

/** Scoped to ONE job (`payload->>'messageJobId'`) - `transitionId` is the job id (reconciler.ts's own doc comment), so this is the exact per-transition dedupe scope `notify()`'s unique constraint enforces, never a client-wide count (a sibling job sharing the same ambiguity sweep gets its OWN notification, which is correct - not a duplicate). */
async function countUnresolvedSendNotificationsForJob(
  testPool: TestPool,
  clientId: string,
  messageJobId: string,
): Promise<number> {
  const result = await testPool.query<NotificationCountRow>(
    `SELECT count(*)::text AS count FROM notifications
      WHERE client_id = $1 AND kind = 'unresolved_send' AND payload->>'messageJobId' = $2`,
    [clientId, messageJobId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('runOneReconcilerSweep unresolved_send notify (P17 fix round F2)', () => {
  it('an_ambiguous_echo_match_sends_exactly_one_unresolved_send_notification', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'ambiguous-notify-body',
    });
    const seededA = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
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

    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seededA.jobId],
    );
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(
      await countUnresolvedSendNotificationsForJob(pool, seededA.clientId, seededA.jobId),
    ).toBe(1);
  });

  it('running_the_sweep_twice_for_the_same_job_still_sends_exactly_one_notification', async () => {
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'expired-notify-dedupe-body',
    });
    const dispatchedAt = new Date(Date.now() - RECONCILE_WINDOW_MS - 1000);
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash, dispatchedAt });

    const deps = buildDeps();
    await runOneReconcilerSweep(deps);
    // A second sweep re-scans the SAME row - it is already
    // `blocked_needs_review`, not `needs_reconcile`, so `wp_reconcile_scan_
    // unresolved` no longer selects it and applyExpired never re-fires. The
    // notify() dedupe key (transitionId = message_job_id) also guarantees no
    // second row even if a future scan-window change ever re-surfaced it.
    await runOneReconcilerSweep(deps);

    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(await countUnresolvedSendNotificationsForJob(pool, seeded.clientId, seeded.jobId)).toBe(
      1,
    );
  });

  it('a_rolled_back_transaction_sharing_the_transition_write_and_notify_leaves_zero_notification_rows', async () => {
    // Exercises the SAME shape applyAmbiguous uses (the transition UPDATE +
    // notify() on one withTenant transaction), forced to roll back - proves
    // the two writes are NEVER split across separate transactions (the exact
    // bug this fix round corrected: a post-commit notify would survive a
    // rollback of the transition write, orphaning an alert for a job that
    // was never actually transitioned).
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'rollback-proof-body',
    });
    const seeded = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });

    await expect(
      tenantDb.withTenant(seeded.clientId, async (tx) => {
        await tx.query(
          `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
                  unresolved_reason = 'ambiguous_echo_match', unresolved_at = now()
            WHERE id = $1 AND client_id = $2 AND status = 'needs_reconcile'`,
          [seeded.jobId, seeded.clientId],
        );
        await notify(tx, {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          kind: 'unresolved_send',
          transitionId: seeded.jobId,
          payload: { messageJobId: seeded.jobId },
          requiresUserAction: true,
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('needs_reconcile');
    expect(await countUnresolvedSendNotificationsForJob(pool, seeded.clientId, seeded.jobId)).toBe(
      0,
    );
  });

  it('a_notify_failure_inside_the_same_transaction_still_commits_the_blocked_needs_review_write', async () => {
    // Forces a REAL notify() failure (an FK violation on notifications.
    // instance_id - the instance row is deleted between seed and sweep,
    // simulating an instance purged while a job was mid-flight) - proves
    // F5's fail-safe layering: the transition write still commits even
    // though notify() throws inside the SAME transaction.
    const contentHash = computeContentHash({
      jid: '1@s.whatsapp.net',
      kind: 'text',
      text: 'notify-failure-still-commits-body',
    });
    const seededA = await seedNeedsReconcileJob(pool, probeClientIds, { contentHash });
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

    // Drop the instance's own dependents first (FK-blocked otherwise), then
    // the instance row itself - message_jobs/send_attempts carry no FK to
    // whatsapp_instances, so the job/evidence rows this test seeded above
    // are untouched.
    await pool.query('DELETE FROM instance_pacing_state WHERE instance_id = $1', [
      seededA.instanceId,
    ]);
    await pool.query('DELETE FROM instance_lease_state WHERE instance_id = $1', [
      seededA.instanceId,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE id = $1', [seededA.instanceId]);

    const deps = buildDeps();
    // Never throws - runOneReconcilerSweep itself never propagates a
    // per-candidate notify failure.
    await expect(runOneReconcilerSweep(deps)).resolves.toBeUndefined();

    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seededA.jobId],
    );
    expect(job.rows[0]?.status).toBe('blocked_needs_review');
    expect(
      await countUnresolvedSendNotificationsForJob(pool, seededA.clientId, seededA.jobId),
    ).toBe(0);
  });
});
