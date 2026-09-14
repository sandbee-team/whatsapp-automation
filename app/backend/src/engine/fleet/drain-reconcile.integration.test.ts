import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { createTenantDb } from '@wp/db';
import { describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createDrain, markNeedsReconcile, type InFlightEntry } from './drain.js';

/**
 * drain-reconcile.integration.test.ts (P09 U4 step 7, FIX-P09-B split) -
 * real PG proof of `markNeedsReconcile`'s two behaviors, split out of
 * `drain.integration.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same cases, unchanged). See `drain-flow.integration.test.ts`
 * for the full-drain-run case.
 *
 *   `inflight_send_past_twenty_seconds_becomes_needs_reconcile` - a real
 *   `message_jobs` row seeded at `status = 'processing'` plus a fake
 *   in-flight entry that never quiesces; with a SHORT injected
 *   `inFlightWaitMs` (200ms - the property proven is the transition +
 *   never-requeue, not the 20s constant itself), the job ends at
 *   `needs_reconcile`, never requeued, never failed, attempts untouched.
 *
 *   `WARNING FIX 6` - `markNeedsReconcile` with a mismatched `instance_id`
 *   is a zero-row no-op, never reconciling under the wrong instance.
 */

describe('createDrain - real PG+Redis', () => {
  it('inflight_send_past_twenty_seconds_becomes_needs_reconcile', async () => {
    const { createPool } = await import('@wp/db');
    const realPool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'app-backend-tests',
    });

    const clientId = randomUUID();
    const instanceId = randomUUID();

    try {
      await realPool.query(
        'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
        [clientId, 'Drain Reconcile Probe Client', `drain-reconcile-probe-${clientId}`, 'active'],
      );
      await realPool.query(
        `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
         VALUES ($1, $2, $3, 'connected', 0)`,
        [instanceId, clientId, 'probe'],
      );

      const jobResult = await realPool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
            payload, payload_kind, priority, priority_rank, status, scheduled_at,
            next_attempt_at, attempts, lease_owner, lease_id, owner_fence, leased_at,
            lease_expires_at)
         VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'processing',
                 now(), now(), 1, 'worker-drain-reconcile', gen_random_uuid(), 1, now(),
                 now() + interval '30 seconds')
         RETURNING id`,
        [
          clientId,
          instanceId,
          '15550000000@s.whatsapp.net',
          JSON.stringify({ text: 'drain-reconcile-probe' }),
        ],
      );
      const jobId = jobResult.rows[0]?.id;
      if (!jobId) throw new Error('seed job failed');

      const leftover: InFlightEntry = { jobId, instanceId, clientId };
      const tenantDb = createTenantDb(realPool);

      const exit = vi.fn();
      const drain = createDrain({
        beginDrain: vi.fn(),
        stopClaiming: vi.fn(async () => undefined),
        inFlight: {
          list: () => [leftover],
          // Never quiesces - simulates a send that is still in flight past
          // the deadline.
          awaitQuiescence: () => new Promise<void>(() => undefined),
        },
        markNeedsReconcile: async (job) => {
          await tenantDb.withTenant(job.clientId, (tx) => markNeedsReconcile(tx, job));
        },
        sessions: [],
        closePools: vi.fn(async () => undefined),
        exit,
        deadlines: { inFlightWaitMs: 200, totalMs: 2000 },
      });

      await drain.run();

      expect(exit).toHaveBeenCalledWith(0);

      const jobRow = await realPool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(jobRow.rows[0]?.status).toBe('needs_reconcile');
      expect(jobRow.rows[0]?.attempts).toBe(1);

      // Idempotent + never requeues: calling markNeedsReconcile again on the
      // now-needs_reconcile row matches zero rows and stays needs_reconcile
      // (never re-queued, never failed).
      await tenantDb.withTenant(clientId, (tx) => markNeedsReconcile(tx, leftover));
      const jobRowAfterReplay = await realPool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(jobRowAfterReplay.rows[0]?.status).toBe('needs_reconcile');
      expect(jobRowAfterReplay.rows[0]?.attempts).toBe(1);
    } finally {
      await realPool.query('DELETE FROM message_jobs WHERE client_id = $1', [clientId]);
      await realPool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [clientId]);
      await realPool.query('DELETE FROM clients WHERE id = $1', [clientId]);
      await realPool.end();
    }
  }, 30_000);

  it('WARNING FIX 6: markNeedsReconcile with a mismatched instance_id is a zero-row no-op, never reconciling under the wrong instance', async () => {
    const { createTenantDb } = await import('@wp/db');
    const { createPool } = await import('@wp/db');
    const realPool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'app-backend-tests',
    });

    const clientId = randomUUID();
    const instanceId = randomUUID();
    const otherInstanceId = randomUUID();

    try {
      await realPool.query(
        'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
        [
          clientId,
          'Drain Reconcile Mismatch Probe',
          `drain-reconcile-mismatch-${clientId}`,
          'active',
        ],
      );
      await realPool.query(
        `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
         VALUES ($1, $2, $3, 'connected', 0)`,
        [instanceId, clientId, 'probe-a'],
      );
      await realPool.query(
        `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
         VALUES ($1, $2, $3, 'connected', 0)`,
        [otherInstanceId, clientId, 'probe-b'],
      );

      const jobResult = await realPool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
            payload, payload_kind, priority, priority_rank, status, scheduled_at,
            next_attempt_at, attempts, lease_owner, lease_id, owner_fence, leased_at,
            lease_expires_at)
         VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'processing',
                 now(), now(), 1, 'worker-drain-reconcile', gen_random_uuid(), 1, now(),
                 now() + interval '30 seconds')
         RETURNING id`,
        [
          clientId,
          instanceId,
          '15550000000@s.whatsapp.net',
          JSON.stringify({ text: 'drain-reconcile-mismatch-probe' }),
        ],
      );
      const jobId = jobResult.rows[0]?.id;
      if (!jobId) throw new Error('seed job failed');

      const tenantDb = createTenantDb(realPool);

      // Job actually belongs to `instanceId`, but the caller (e.g. a stale
      // in-flight snapshot) passes `otherInstanceId` - must match ZERO rows
      // and leave the job's status untouched.
      await tenantDb.withTenant(clientId, (tx) =>
        markNeedsReconcile(tx, { jobId, instanceId: otherInstanceId, clientId }),
      );

      const jobRow = await realPool.query<{ status: string }>(
        'SELECT status FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(jobRow.rows[0]?.status).toBe('processing');

      // The CORRECT instance_id still transitions it normally, proving the
      // predicate is additive (never globally broken).
      await tenantDb.withTenant(clientId, (tx) =>
        markNeedsReconcile(tx, { jobId, instanceId, clientId }),
      );
      const jobRowAfterCorrect = await realPool.query<{ status: string }>(
        'SELECT status FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(jobRowAfterCorrect.rows[0]?.status).toBe('needs_reconcile');
    } finally {
      await realPool.query('DELETE FROM message_jobs WHERE client_id = $1', [clientId]);
      await realPool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [clientId]);
      await realPool.query('DELETE FROM clients WHERE id = $1', [clientId]);
      await realPool.end();
    }
  }, 30_000);
});
