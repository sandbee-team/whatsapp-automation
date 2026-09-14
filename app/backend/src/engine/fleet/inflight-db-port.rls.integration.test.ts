import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import { buildDbInFlightPort } from './inflight-db-port.js';
import { createDrain, markNeedsReconcile } from './drain.js';

/**
 * inflight-db-port.rls.integration.test.ts (C1 CRITICAL FINDING 1 fix,
 * 2026-09-11) - proves `buildDbInFlightPort` lists a real in-flight
 * `message_jobs` row under the ACTUAL production role (`wp_scheduler`),
 * which requires `app.client_id` to be set via `tenantDb.withTenant` before
 * the leftover query runs (RLS is `FORCE`d on `message_jobs` - migration
 * 0007). The dev/test pool connects as the superuser `wp`
 * (`rolbypassrls = true`), which is why every other test in this tree is
 * blind to a raw-pool regression here - only a role-scoped connection
 * (`wp_scheduler`, `rolbypassrls = false`) can prove or disprove it. Mirrors
 * `engine/queue/send-loop-worker-wiring.rls.integration.test.ts`'s idiom
 * exactly (same class of bug, same fix, same proof shape).
 *
 * Negative control: a bare `pool.query()` of the identical statement under
 * `wp_scheduler` (no `app.client_id` GUC) returns zero rows - proving the
 * class of bug this test exists to catch, not just the fix.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'inflight-db-port-rls-test',
});
let probeClientIds: string[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length === 0) return;
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
  probeClientIds = [];
});

interface SeededInFlight {
  clientId: string;
  instanceId: string;
  jobId: string;
}

async function seedProcessingJob(): Promise<SeededInFlight> {
  const clientId = randomUUID();
  const instanceId = randomUUID();
  probeClientIds.push(clientId);

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'InFlight RLS Probe Client',
    `inflight-rls-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'inflight-rls-probe', 'connected', 0)`,
    [instanceId, clientId],
  );
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at,
        next_attempt_at, attempts, lease_owner, lease_id, owner_fence, leased_at,
        lease_expires_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'processing',
             now(), now(), 1, 'worker-inflight-rls', gen_random_uuid(), 1, now(),
             now() + interval '30 seconds')
     RETURNING id`,
    [
      clientId,
      instanceId,
      '15550000000@s.whatsapp.net',
      JSON.stringify({ text: 'inflight-rls-probe' }),
    ],
  );
  const jobId = jobResult.rows[0]?.id;
  if (!jobId) throw new Error('seedProcessingJob: no row returned');
  return { clientId, instanceId, jobId };
}

describe('buildDbInFlightPort - real wp_scheduler role + RLS', () => {
  it('lists_the_seeded_in_flight_job_under_the_real_wp_scheduler_role_and_marks_it_needs_reconcile', async () => {
    const seeded = await seedProcessingJob();
    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');

    const inFlight = buildDbInFlightPort(
      tenantDbAsScheduler,
      [{ instanceId: seeded.instanceId, clientId: seeded.clientId }],
      5,
    );

    await inFlight.awaitQuiescence(50);

    expect(inFlight.list()).toEqual([
      { jobId: seeded.jobId, instanceId: seeded.instanceId, clientId: seeded.clientId },
    ]);

    const drain = createDrain({
      beginDrain: () => undefined,
      stopClaiming: async () => undefined,
      inFlight: {
        list: () => inFlight.list(),
        awaitQuiescence: () => Promise.resolve(),
      },
      markNeedsReconcile: (job) =>
        tenantDbAsScheduler.withTenant(job.clientId, (tx) => markNeedsReconcile(tx, job)),
      sessions: [],
      closePools: async () => undefined,
      exit: () => undefined,
      deadlines: { inFlightWaitMs: 50, totalMs: 2000 },
    });

    await drain.run();

    const jobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('needs_reconcile');
  }, 30_000);

  it('a_bare_pool_query_of_the_identical_statement_under_wp_scheduler_with_no_guc_returns_zero_rows', async () => {
    // Regression sentinel (negative control): proves the class of bug C1
    // FINDING 1 describes. If buildDbInFlightPort were reverted to a raw
    // `pool.query()` (no app.client_id GUC), THIS is what it would see -
    // silent, permanent zero in-flight rows forever under wp_scheduler.
    const seeded = await seedProcessingJob();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      // Deliberately NO set_config('app.client_id', ...) call.
      const result = await client.query(
        `SELECT id, instance_id, client_id FROM message_jobs
          WHERE status = 'processing' AND instance_id = ANY($1) AND client_id = $2
          ORDER BY id LIMIT 500`,
        [[seeded.instanceId], seeded.clientId],
      );
      expect(result.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 30_000);
});
