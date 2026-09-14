import { createMetricsRegistry } from '@wp/server-kit';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics, type QueueMetricsHandles } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep, type ReaperDeps } from './reaper.js';
import { runOneReconcilerSweep, type ReconcilerDeps } from './reconciler.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';
import {
  CRASH_CHECKPOINTS,
  injectCrashAt,
  mulberry32,
  pickCrashCheckpoint,
  type CrashCheckpoint,
} from './__tests__/crash-injector.js';

/**
 * crash-recovery.integration.test.ts (P12 Unit U6b, step 9 harness half) -
 * the 100x `kill -9` chaos harness. 100 iterations, each seeding one claimed
 * job and crash-injecting it at a randomised checkpoint (seeded PRNG - see
 * `crash-injector.ts`'s own header for why this is deterministic, not
 * `Math.random()`), then a single reaper sweep + reconciler sweep repairs
 * every iteration's job in one batched pass (closer to production than
 * sweeping per-iteration, and the only way 100 real-Postgres iterations fit
 * inside `vitest.config.ts`'s 30s `testTimeout`).
 *
 * Two headline assertions (phase file, verbatim):
 *   1. Zero lost - every job ends terminal or claimable; job-count invariant
 *      holds (100 seeded == 100 accounted for).
 *   2. Zero silent duplicates - the money-seam sink records at most one
 *      `onRepairedSent` call per `send_attempts.id` (no human Retry exists
 *      in this harness, so the bound is exactly <=1, never >1).
 *
 * Cross-tenant assertion hygiene (core-invariants.md): the reaper/reconciler
 * sweeps are genuinely cross-tenant, so every assertion below looks THIS
 * harness's own seeded ids up in a Map of the observed rows - never a total
 * row count or set-equality against the whole table (shared dev DB may hold
 * unrelated leftovers).
 */

const ITERATIONS = 100;
const CHAOS_SEED = 20260901;

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'chaos-harness' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

interface ChaosIteration {
  jobId: string;
  checkpoint: CrashCheckpoint;
  sendAttemptId: string | null;
}

const TERMINAL_STATUSES = new Set(['sent', 'failed', 'cancelled', 'blocked_needs_review']);

describe('the 100x kill-9 chaos harness (real Postgres)', () => {
  it('zero_lost_and_zero_silent_duplicates_across_100_randomised_crash_points', async () => {
    const rng = mulberry32(CHAOS_SEED);
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);

    const iterations: ChaosIteration[] = [];
    const distribution: Record<CrashCheckpoint, number> = {
      no_attempt: 0,
      prepared: 0,
      dispatched: 0,
      acked: 0,
      failed: 0,
    };

    // Seed + crash-inject all 100 iterations first (fast, no sweep yet) -
    // this is the "kill -9 100 workers" half; the sweep below is the
    // "reaper/reconciler come back and repair everything" half, run once
    // as a single batched pass (closer to production, and the only way
    // this fits inside the 30s testTimeout - see this file's own header).
    for (let i = 0; i < ITERATIONS; i += 1) {
      const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 5 });
      await pool.query(
        `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [job.id],
      );

      const checkpoint = pickCrashCheckpoint(rng);
      const injected = await injectCrashAt(
        pool,
        { clientId, instanceId, jobId: job.id, leaseId: job.leaseId, attemptNo: 1 },
        checkpoint,
      );

      distribution[checkpoint] += 1;
      iterations.push({ jobId: job.id, checkpoint, sendAttemptId: injected.sendAttemptId });
    }

    // Sanity: every checkpoint was actually exercised at least once across
    // 100 draws from a 5-way uniform PRNG - if a future edit to
    // pickCrashCheckpoint's weighting silently starved a branch, this
    // headline test would otherwise claim coverage it did not have (task
    // requirement, verbatim).
    for (const checkpoint of CRASH_CHECKPOINTS) {
      expect(distribution[checkpoint]).toBeGreaterThan(0);
    }
    expect(iterations).toHaveLength(ITERATIONS);

    const metrics: QueueMetricsHandles = bindQueueMetrics(createMetricsRegistry());
    const sink = createCountingNoOpRepairedSendSink();
    const tenantDb = createTenantDb(pool);

    const reaperDeps: ReaperDeps = {
      pool,
      tenantDb,
      metrics,
      sink,
      graceSeconds: 30,
      limit: 1000,
      rng: { random: () => 0 },
    };
    await runOneReaperSweep(reaperDeps);

    const reconcilerDeps: ReconcilerDeps = {
      pool,
      tenantDb,
      metrics,
      sink,
      reconcileWindowMs: 5 * 60_000,
      echoToleranceMs: 5 * 60_000,
      maxRows: 1000,
      now: () => Date.now(),
    };
    // The reconciler cannot resolve anything in this harness (no echo
    // evidence is ever seeded - the fake transport never runs), so every
    // 'dispatched' checkpoint's job is expected to WAIT here, not resolve.
    // It is called anyway to prove it never mis-touches a job outside its
    // scan (needs_reconcile), and is re-run below at window expiry.
    await runOneReconcilerSweep(reconcilerDeps);

    // The 'dispatched' checkpoint's jobs are now needs_reconcile, waiting on
    // the (5 minute) reconcile window - a SECOND reconciler sweep with `now`
    // pushed past the window resolves them all to blocked_needs_review
    // (expired branch, never a silent/guessed match - reconciler.ts's own
    // module header). This is the "human must look at it" terminal state
    // for a checkpoint this harness has no way to produce real echo
    // evidence for.
    await runOneReconcilerSweep({
      ...reconcilerDeps,
      now: () => Date.now() + 5 * 60_000 + 60_000,
    });

    const jobIds = iterations.map((iter) => iter.jobId);
    const finalRows = await pool.query<{
      id: string;
      status: string;
      next_attempt_at: Date;
      attempts: number;
    }>('SELECT id, status, next_attempt_at, attempts FROM message_jobs WHERE id = ANY($1)', [
      jobIds,
    ]);
    const byJobId = new Map(finalRows.rows.map((row) => [row.id, row]));

    // Headline assertion 1: zero lost. Job-count invariant - every seeded
    // job is accounted for, and each is either terminal or claimable
    // (queued with a set next_attempt_at). None left stranded 'processing'.
    expect(byJobId.size).toBe(ITERATIONS);
    for (const iter of iterations) {
      const row = byJobId.get(iter.jobId);
      expect(row).toBeDefined();
      if (!row) continue;
      const isTerminal = TERMINAL_STATUSES.has(row.status);
      const isClaimable = row.status === 'queued' && row.next_attempt_at !== null;
      expect(isTerminal || isClaimable).toBe(true);
      expect(row.attempts).toBeGreaterThanOrEqual(0);
    }

    // Headline assertion 2: zero silent duplicates. The sink records at
    // most one `onRepairedSent` call per send_attempts.id - no human Retry
    // exists in this harness, so the bound is exactly <=1, never >1.
    const repairedCounts = new Map<string, number>();
    for (const attemptId of sink.repairedSentCalls) {
      repairedCounts.set(attemptId, (repairedCounts.get(attemptId) ?? 0) + 1);
    }
    for (const count of repairedCounts.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }

    // Every 'acked' checkpoint (repaired to 'sent') owes EXACTLY one sink
    // call - not merely <=1 - proving the sink actually fired for the
    // money-seam-relevant branch, not just that it never over-fired.
    const ackedAttemptIds = iterations
      .filter((iter) => iter.checkpoint === 'acked' && iter.sendAttemptId)
      .map((iter) => iter.sendAttemptId as string);
    for (const attemptId of ackedAttemptIds) {
      expect(repairedCounts.get(attemptId)).toBe(1);
    }

    // 'failed' checkpoint jobs must never be silently re-sent. Migration
    // 0029 (P12 C1 review, finding 2): the reaper's SQL no longer decides a
    // `failed` attempt's disposition on its own - it moves the job to
    // `needs_reconcile` and the reaper MODULE re-drives it, synchronously,
    // in the same sweep, through the REAL `@wp/domain` `classify()`
    // decision (`reclassifyReapedFailure`). `crash-injector.ts` always
    // writes `error_class='transient'` for this checkpoint, which
    // `classify()` maps to `RETRY_BACKOFF` - with `attemptNo=1` well under
    // `maxAttempts=5`, the budget is not exhausted, so every 'failed'
    // checkpoint job in THIS harness ends up requeued to 'queued' with a
    // real jittered backoff (never the old flat 5s, never a blind SQL
    // requeue) - covered by `isClaimable` in the loop above. It never
    // reaches 'sent' and never calls the money-seam sink either way.
    const failedAttemptIds = iterations
      .filter((iter) => iter.checkpoint === 'failed' && iter.sendAttemptId)
      .map((iter) => iter.sendAttemptId as string);
    for (const attemptId of failedAttemptIds) {
      expect(repairedCounts.get(attemptId) ?? 0).toBe(0);
    }

    // Report the distribution actually hit, per the task's "report the
    // distribution" requirement - visible in the test output on any run.
    console.log('chaos harness crash-checkpoint distribution:', distribution);
  });
});
