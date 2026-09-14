import { computeContentHash } from '../../../engine/queue/content-hash.js';
import type { TestPool } from '../../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * crash-injector.ts (P12 Unit U6b, step 9 harness half) - the 100x `kill -9`
 * chaos harness's crash-point machinery. Lives under `__tests__/` so the
 * tenant-scope guard's seed/cleanup exemption covers its raw INSERTs (same
 * convention `queue-send-test-helpers.ts`'s own header documents).
 *
 * DESIGN: rather than re-driving `dispatch()`/`resolveAck()`/`resolveFailure()`
 * themselves (which own real timers - heartbeat interval, send timeout - and
 * would make a 100-iteration run either slow or fight fake timers), this
 * harness writes the exact SQL STATE each of those functions would have
 * committed up to a randomised crash checkpoint, then stops - modelling a
 * `kill -9` at that exact point. This is the same technique
 * `result-crash-window.integration.test.ts`'s `crashAfterFirstTransaction`
 * uses (a real transaction commits, then the "process" stops before the
 * next one opens), generalised to picking WHICH of the four contract
 * checkpoints (P11's fixtured crash states, `result.ts:52-62`) a given
 * iteration lands on, via a seeded PRNG so the run stays deterministic and
 * reproducible (`.claude/rules/core-invariants.md`'s ban on bare
 * `Math.random()` in a test).
 *
 * `kill9` naming precedent: `engine/session/synthetic-fleet-support.ts`'s
 * own `SyntheticWorkerHandle.kill9()` doc explains why an in-process harness
 * can only ever model "stop renewing, never release, never finish the
 * write" - not a literal OS-level SIGKILL. This harness follows the same
 * honesty: `CrashCheckpoint` names the LAST STATEMENT THAT COMMITTED, never
 * claims to simulate the process itself.
 */

/** The four contract checkpoints from `result.ts:52-62`, in pipeline order. */
export const CRASH_CHECKPOINTS = [
  'no_attempt',
  'prepared',
  'dispatched',
  'acked',
  'failed',
] as const;
export type CrashCheckpoint = (typeof CRASH_CHECKPOINTS)[number];

/** Deterministic mulberry32 PRNG - same seed always produces the same sequence, so a failing iteration is reproducible by re-running with the printed seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks one of the five checkpoints uniformly, using `rng()` (expected to return [0, 1)). */
export function pickCrashCheckpoint(rng: () => number): CrashCheckpoint {
  const index = Math.floor(rng() * CRASH_CHECKPOINTS.length);
  return CRASH_CHECKPOINTS[Math.min(index, CRASH_CHECKPOINTS.length - 1)] as CrashCheckpoint;
}

export interface CrashInjectionSeed {
  clientId: string;
  instanceId: string;
  jobId: string;
  leaseId: string;
  attemptNo: number;
}

export interface CrashInjectionResult {
  checkpoint: CrashCheckpoint;
  sendAttemptId: string | null;
}

/**
 * Writes real DB state up to (and including) `checkpoint`, then returns -
 * simulating a `kill -9` immediately after that write's commit. Every write
 * below is the SAME SQL shape `dispatch.ts`/`result.ts` themselves issue
 * (kept in sync manually - both are read-only inputs this dispatch may not
 * edit), just executed directly against `pool` instead of through a fake
 * transport + real timers, so 100 iterations run in milliseconds of wall
 * clock rather than fighting `TIMING.sendTimeoutMs`/heartbeat intervals.
 *
 * `no_attempt`: nothing written (the job stays exactly as `seedClaimedJob`
 * left it - claimed, zero attempts recorded).
 */
export async function injectCrashAt(
  pool: TestPool,
  seed: CrashInjectionSeed,
  checkpoint: CrashCheckpoint,
): Promise<CrashInjectionResult> {
  if (checkpoint === 'no_attempt') {
    return { checkpoint, sendAttemptId: null };
  }

  const contentHash = computeContentHash({
    jid: `${seed.jobId}@s.whatsapp.net`,
    kind: 'text',
    text: 'chaos-harness-probe',
  });

  // `message_job_created_at` is resolved SERVER-SIDE via a subquery on the
  // globally-unique `id`, never re-bound from a JS `Date` - a `timestamptz`
  // round-tripped through JS truncates microsecond precision, which would
  // silently break `wp_reap_expired_leases`'/`wp_reconcile_scan_unresolved`'s
  // own `a.message_job_created_at = j.created_at` join (see
  // `queue-send-test-helpers.ts`/`reaper.integration.test.ts`'s own comments
  // on the same finding - `.memory/lessons/2026-09-01-timestamptz-
  // microseconds-vs-js-date-milliseconds.md`).
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, content_hash, state, prepared_at)
     SELECT $1, $2, $3, j.created_at, $4, $5, $6, 'prepared', now()
       FROM message_jobs j WHERE j.id = $3
     RETURNING id`,
    [seed.clientId, seed.instanceId, seed.jobId, seed.leaseId, seed.attemptNo, contentHash],
  );
  const sendAttemptId = inserted.rows[0]?.id;
  if (!sendAttemptId) throw new Error('injectCrashAt: no send_attempts row returned');

  await pool.query(`UPDATE message_jobs SET attempts = attempts + 1 WHERE id = $1`, [seed.jobId]);

  if (checkpoint === 'prepared') {
    return { checkpoint, sendAttemptId };
  }

  await pool.query(
    `UPDATE send_attempts SET state = 'dispatched', dispatched_at = now() WHERE id = $1`,
    [sendAttemptId],
  );

  if (checkpoint === 'dispatched') {
    return { checkpoint, sendAttemptId };
  }

  // 'acked' / 'failed': the attempt-state write (markAttempt's exact SQL
  // shape) commits, modelling `resolveAck`/`resolveFailure`'s FIRST
  // transaction landing - then the "process" dies before the second
  // transaction (the message_jobs outcome write) ever opens. This is
  // EXACTLY the state result-crash-window.integration.test.ts fixtures.
  const providerMsgId = checkpoint === 'acked' ? `wamid.chaos-${sendAttemptId}` : null;
  const errorClass = checkpoint === 'failed' ? 'transient' : null;
  await pool.query(
    `UPDATE send_attempts SET state = $2, provider_msg_id = $3, error_class = $4, resolved_at = now()
       WHERE id = $1`,
    [sendAttemptId, checkpoint, providerMsgId, errorClass],
  );

  return { checkpoint, sendAttemptId };
}
