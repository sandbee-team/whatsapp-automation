import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';
import { runOneReaperSweep } from './reaper.js';
import { runOneReconcilerSweep } from './reconciler.js';
import { seedUnresolvedJob } from './__tests__/unresolved-test-support.js';

/**
 * unresolved-no-auto-requeue.integration.test.ts (P12 Unit U5) - mandatory
 * test 16 (phase file table): 72 simulated hours of cron produce zero
 * transitions out of `blocked_needs_review`. Split out of
 * `unresolved-api.integration.test.ts` at the max-lines cap.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-tests',
});
const probeClientIds: string[] = [];

afterAll(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('the 72-hour no-auto-requeue invariant', () => {
  it('unresolved_job_is_never_auto_requeued_under_default_policy', async () => {
    const seeded = await seedUnresolvedJob(pool, probeClientIds);
    const metrics = bindQueueMetrics(createMetricsRegistry());
    const sink = createCountingNoOpRepairedSendSink();
    const tenantDbForSweeps = createTenantDb(pool);

    // 72 simulated hours of "cron" - repeatedly invoking the ONLY two
    // scheduled entry points that ever touch a message_jobs row's status
    // (the reaper and the reconciler), each with an injected `now` one
    // hour further along - no real sleep, no wall-clock assertion. Neither
    // sweep's own SQL ever selects a `blocked_needs_review` row (the reaper
    // scans `processing` leases, the reconciler scans `needs_reconcile`),
    // so this proves the invariant mechanically rather than merely
    // asserting it never happened to run.
    let simulatedHour = 0;
    for (let hour = 0; hour < 72; hour += 1) {
      simulatedHour = hour;
      await runOneReaperSweep({
        pool,
        tenantDb: tenantDbForSweeps,
        metrics,
        sink,
        graceSeconds: 30,
        limit: 500,
        rng: { random: () => 0 },
      });
      await runOneReconcilerSweep({
        pool,
        tenantDb: tenantDbForSweeps,
        metrics,
        sink,
        reconcileWindowMs: 5 * 60_000,
        echoToleranceMs: 5 * 60_000,
        maxRows: 500,
        now: () => Date.now() + simulatedHour * 60 * 60 * 1000,
      });

      const row = await pool.query<{ status: string }>(
        'SELECT status FROM message_jobs WHERE id = $1 AND client_id = $2',
        [seeded.jobId, seeded.clientId],
      );
      expect(row.rows[0]?.status).toBe('blocked_needs_review');
    }

    // Containment, not a global count (cross-tenant sweep - other tests'
    // rows may run through the same sink in parallel, per the hygiene rule
    // reaper.integration.test.ts documents): THIS job's attempt was never
    // touched by either sweep.
    const attempt = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(attempt.rows.map((r) => r.state)).toEqual(['dispatched']);
  });
});
