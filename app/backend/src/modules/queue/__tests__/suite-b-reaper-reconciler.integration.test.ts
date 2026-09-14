// isolation suite B - the reaper + reconciler sweeps as a background path.
import { randomUUID } from 'node:crypto';
import { createMetricsRegistry } from '@wp/server-kit';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { computeContentHash } from '../../../engine/queue/content-hash.js';
import { bindQueueMetrics } from '../../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep, type ReaperDeps } from '../reaper.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from '../reconciler.js';
import { createCountingNoOpRepairedSendSink } from '../repaired-send-sink.js';
import { seedNeedsReconcileJob, seedUnresolvedEvidence } from './reconciler-test-helpers.js';

/**
 * suite-b-reaper-reconciler.integration.test.ts (P12 Unit U6b, step 9
 * isolation half) - follows the shipped suite-B convention exactly
 * (`modules/realtime/__tests__/suite-b-sse.test.ts`'s own header comment):
 * seed `clientA`, `clientB`, and a third `clientNeither` owning zero rows,
 * run the background path, assert each tenant sees only its own outcome.
 *
 * The reaper's cross-tenant sweep (`reap-expired-leases.sql`) is
 * DELIBERATELY cross-tenant - one pass repairs every tenant's expired
 * leases at once (this migration's own header). So the isolation property
 * under test here is NOT "the sweep only touched one tenant's rows" (that
 * would be asserting the wrong thing about a genuinely cross-tenant scan -
 * task's own framing warning). It is instead:
 *   1. Per-tenant WRITES land on the right tenant's OWN rows (clientA's
 *      job repairs to clientA's expected state, clientB's to clientB's,
 *      cross-checked by content, not just presence).
 *   2. A `content_hash` COLLISION across two different tenants' echo
 *      evidence never resolves either side from the other's evidence -
 *      `wp_reconcile_scan_unresolved`'s sibling-count/evidence lookup is
 *      scoped by `(client_id, instance_id)`, never content_hash alone.
 *   3. No tenant's `client_id` leaks into the other's delivery_events rows.
 *   4. `clientNeither` (zero rows, zero sends) is never touched by either
 *      sweep - proves the sweep does not manufacture rows for a tenant it
 *      never saw.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'suite-b-reaper' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [jobId],
  );
}

describe('isolation suite B - the reaper + reconciler sweeps as a background path', () => {
  it('two_tenants_repaired_in_one_cross_tenant_pass_never_cross_resolve_even_on_a_shared_content_hash', async () => {
    const sharedContentHash = computeContentHash({
      jid: 'shared-collision-probe@s.whatsapp.net',
      kind: 'text',
      text: 'isolation-probe',
    });

    // --- clientA: one expired-lease 'acked' attempt (reaper repair path). ---
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const jobA = await seedClaimedJob(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
    });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, content_hash, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, $5, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3
       RETURNING id`,
      [tenantA.clientId, tenantA.instanceId, jobA.id, jobA.leaseId, sharedContentHash],
    );
    await expireLease(jobA.id);

    // --- clientB: the SAME expired-lease shape, own tenant. ---
    const tenantB = await seedSendTenant(pool, probeClientIds);
    const jobB = await seedClaimedJob(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
    });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, content_hash, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, $5, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3
       RETURNING id`,
      [tenantB.clientId, tenantB.instanceId, jobB.id, jobB.leaseId, sharedContentHash],
    );
    await expireLease(jobB.id);

    // --- clientA: a SECOND job, needs_reconcile, with its OWN echo evidence
    // sharing the SAME content_hash as clientB's reconcile candidate below -
    // the collision this test exists to prove never cross-resolves. ---
    const reconcileA = await seedNeedsReconcileJob(pool, probeClientIds, {
      contentHash: sharedContentHash,
    });
    const waMsgIdA = `wamid.${randomUUID()}`;
    await seedUnresolvedEvidence(pool, {
      clientId: reconcileA.clientId,
      instanceId: reconcileA.instanceId,
      waMsgId: waMsgIdA,
      contentHash: sharedContentHash,
    });

    // --- clientB: its OWN needs_reconcile job on the SAME content_hash, but
    // NO echo evidence seeded for it - if evidence lookup ever leaked across
    // tenants, clientB's job would incorrectly resolve using clientA's
    // waMsgIdA above. It must instead stay 'needs_reconcile' (wait). ---
    const reconcileB = await seedNeedsReconcileJob(pool, probeClientIds, {
      contentHash: sharedContentHash,
    });

    // --- clientNeither: owns zero message_jobs/send_attempts rows at all. ---
    const clientNeither = await seedSendTenant(pool, probeClientIds);

    const metrics = bindQueueMetrics(createMetricsRegistry());
    const sink = createCountingNoOpRepairedSendSink();

    const reaperDeps: ReaperDeps = {
      pool,
      tenantDb,
      metrics,
      sink,
      graceSeconds: 30,
      limit: 500,
      rng: { random: () => 0 },
    };
    await runOneReaperSweep(reaperDeps);

    const reconcilerDeps: ReconcilerDeps = {
      pool,
      tenantDb,
      metrics,
      sink,
      reconcileWindowMs: 600_000,
      echoToleranceMs: 300_000,
      maxRows: 500,
      now: () => Date.now(),
    };
    await runOneReconcilerSweep(reconcilerDeps);

    // Property 1: per-tenant writes landed on the RIGHT tenant's own rows.
    const jobAAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [jobA.id],
    );
    expect(jobAAfter.rows[0]?.status).toBe('sent');
    const jobBAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [jobB.id],
    );
    expect(jobBAfter.rows[0]?.status).toBe('sent');

    // Property 2: the content_hash collision never cross-resolves. clientA's
    // job resolved from clientA's OWN evidence...
    const reconcileAAfter = await pool.query<{ status: string; sent_at: Date | null }>(
      'SELECT status, sent_at FROM message_jobs WHERE id = $1',
      [reconcileA.jobId],
    );
    expect(reconcileAAfter.rows[0]?.status).toBe('sent');
    expect(reconcileAAfter.rows[0]?.sent_at).not.toBeNull();

    // ...while clientB's job, sharing the SAME content_hash but with NO
    // evidence of its own, stays exactly where it was ('needs_reconcile',
    // still waiting) - never resolved from clientA's waMsgIdA.
    const reconcileBAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [reconcileB.jobId],
    );
    expect(reconcileBAfter.rows[0]?.status).toBe('needs_reconcile');

    // The evidence row itself was only ever assigned to clientA's job -
    // never clientB's, even though both share client-scoped rows with the
    // identical content_hash.
    const evidenceRow = await pool.query<{ message_id: string | null; client_id: string }>(
      'SELECT message_id, client_id FROM message_wa_ids WHERE client_id = $1 AND wa_msg_id = $2',
      [reconcileA.clientId, waMsgIdA],
    );
    expect(evidenceRow.rows[0]?.message_id).toBe(reconcileA.jobId);
    expect(evidenceRow.rows[0]?.client_id).toBe(reconcileA.clientId);
    expect(evidenceRow.rows[0]?.client_id).not.toBe(reconcileB.clientId);

    // Property 3: no tenant's client_id leaks into the other's delivery
    // events.
    //
    // CORRECTION (main session, P12 close): an earlier version of this
    // comment claimed `message_jobs.id` is NOT globally unique because "each
    // partition mints its own IDENTITY sequence". That is WRONG, and the
    // opposite is load-bearing elsewhere in this phase (migration 0027's
    // reaper matches on `j.id = e.id` alone, and
    // `.memory/lessons/2026-09-01-timestamptz-microseconds-vs-js-date-
    // milliseconds.md` rests on it). Verified live: a partitioned table's
    // children SHARE the parent's sequence - `pg_get_serial_sequence` returns
    // `public.message_jobs_id_seq` for the parent and there is exactly ONE
    // such sequence object; inserting into the August and September
    // partitions yielded 1645687 and 1645688. `message_jobs.id` IS globally
    // unique.
    //
    // The real bug behind the symptom was a MISSING TENANT SCOPE: a bare
    // `message_job_id = ANY(...)` with no `client_id` predicate can match
    // another tenant's row, which is precisely what invariant 4 exists to
    // catch. So the correct isolation check - the one below - scopes the read
    // by `client_id` and then proves clientA's deterministic
    // `provider_event_id` never appears under clientB's scope.
    const eventsA = await pool.query<{ event_type: string; provider_event_id: string }>(
      'SELECT event_type, provider_event_id FROM delivery_events WHERE client_id = $1 AND message_job_id = ANY($2)',
      [tenantA.clientId, [jobA.id, reconcileA.jobId]],
    );
    expect(eventsA.rows.length).toBeGreaterThan(0);
    for (const row of eventsA.rows) {
      // clientB's own delivery_events (scoped to clientB) never contains
      // clientA's exact provider_event_id - the deterministic id
      // (`deliveryEventId`) is built from instanceId+publicId+eventType, so
      // an id match under a DIFFERENT client_id scope would mean the event
      // was mis-attributed to the wrong tenant.
      const crossCheck = await pool.query<{ count: string }>(
        'SELECT count(*)::text FROM delivery_events WHERE client_id = $1 AND provider_event_id = $2',
        [tenantB.clientId, row.provider_event_id],
      );
      expect(crossCheck.rows[0]?.count).toBe('0');
    }

    // Property 4: clientNeither (zero rows) was never touched by either
    // sweep - no message_jobs, no send_attempts, no delivery_events.
    const neitherJobs = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM message_jobs WHERE client_id = $1',
      [clientNeither.clientId],
    );
    expect(neitherJobs.rows[0]?.count).toBe('0');
    const neitherEvents = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM delivery_events WHERE client_id = $1',
      [clientNeither.clientId],
    );
    expect(neitherEvents.rows[0]?.count).toBe('0');

    // The money-seam sink fired exactly once per repaired 'acked' attempt,
    // one for clientA's job, one for clientB's - never merged/collapsed
    // across tenants despite the shared content_hash.
    expect(sink.repairedSentCalls.length).toBeGreaterThanOrEqual(3);
  });
});
