// priority_rank IS the DWRR band weight (HIGH 6 / NORMAL 3 / LOW 1) - the send loop claims
// `j.priority_rank = $band` with exactly these values; a literal 10 is unclaimable (P26 run log #13).
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { createPool } from '@wp/db';
import { DEFAULT_BAND_WEIGHTS } from '@wp/domain';
import { publishWake } from '../queue/wake.js';

/**
 * measure-enqueue.ts (P26) - the ONE authority for "how a measurement
 * harness enqueues a real send". Four harnesses previously carried
 * byte-identical copies of this two-table INSERT
 * (`send-load-driver-run.ts`, `run-pg-load.ts`, `run-pacing-windows.ts`,
 * `test/integration/scale/pacing-run-workload.ts`) and NONE of them
 * published a wake.
 *
 * WHY THE WAKE MATTERS (measured, 2026-09-07): the fleet send loop claims
 * ONE job per trigger, and a trigger is either a Redis wake published at
 * enqueue or the 60s +/- 12s safety poll. A harness that only INSERTs makes
 * every run POLL-bound (one send per instance per ~60s, children reporting
 * `wakes=0`) instead of PACING-bound (the 15s `ABSOLUTE_GAP_MIN_MS` floor),
 * which silently distorts the load model, the pacing run and the chaos runs.
 * The real path does publish: `messages.service.ts:289` awaits `onEnqueued`
 * strictly AFTER its `withTenant` transaction has committed, and
 * `roles/api.ts:154` binds that port to
 * `publishWake(redis, config.NODE_ENV, clientId, instanceId)`.
 *
 * ORDERING: the wake is published AFTER `pool.query` has resolved, i.e.
 * after the insert has committed (a single-statement `pool.query` is its own
 * implicit transaction) - never before, or a subscriber can wake to a row it
 * cannot yet see under its own read (`wake.ts`'s own module doc).
 *
 * FAILURE MODE: a wake is a HINT, never an authority. `publishWake` already
 * swallows a rejecting `publish` internally, and this module adds no
 * throwing path of its own around it - a dead Redis degrades a run back to
 * poll-bound, it never fails the durable enqueue (the safety poll is the
 * correctness path).
 *
 * `env` MUST match the value the subscriber side passes, because the channel
 * is `wp:{env}:wake:c:{clientId}:i:{instanceId}` - the harness children pass
 * `env: 'test'` to `bootSendLoopFleetWiring` (`scale-fleet-child.ts:118`),
 * so every measurement caller passes `'test'` here. A mismatch is silent:
 * the publish succeeds onto a channel nobody is subscribed to.
 */

export interface MeasureEnqueueJob {
  clientId: string;
  instanceId: string;
  recipientJid: string;
  text: string;
  idempotencyKey: string;
}

export interface MeasureEnqueueDeps {
  pool: ReturnType<typeof createPool>;
  /** The `redis-ctl` tier handle - the same tier `wake.ts` documents for wake traffic. */
  redisCtl: Redis;
  /** Must equal the `env` the send-loop subscriber was booted with (`'test'` for the scale harness children). */
  env: string;
}

/**
 * Builds the shared durable enqueue port: one `message_jobs` row plus its
 * `message_job_refs` idempotency-authority row in ONE statement (so a job
 * can never exist without its idempotency key - invariant 1 and invariant 3),
 * then one wake for that exact `(clientId, instanceId)` pair.
 */
export function createMeasureEnqueue(
  deps: MeasureEnqueueDeps,
): (job: MeasureEnqueueJob) => Promise<void> {
  return async (job) => {
    await deps.pool.query(
      `WITH inserted AS (
         INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
            payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
         VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', ${String(DEFAULT_BAND_WEIGHTS.NORMAL)}, 'queued', now(), now())
         RETURNING id, created_at
       )
       INSERT INTO message_job_refs
         (public_id, client_id, instance_id, message_job_id, message_job_created_at, idempotency_key)
       SELECT $5, $1, $2, inserted.id, inserted.created_at, $6 FROM inserted`,
      [
        job.clientId,
        job.instanceId,
        job.recipientJid,
        JSON.stringify({ text: job.text }),
        randomUUID(),
        job.idempotencyKey,
      ],
    );
    await publishWake(deps.redisCtl, deps.env, job.clientId, job.instanceId);
  };
}
