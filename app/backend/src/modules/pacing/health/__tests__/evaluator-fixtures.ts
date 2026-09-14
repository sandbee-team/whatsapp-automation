import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * __tests__/evaluator-fixtures.ts (P16 Unit C) - shared, non-test fixture
 * machinery for `evaluator.integration.test.ts` and `evaluator-atomicity.
 * integration.test.ts`: the EWMA-priming trick both files use to force
 * WATCH on the very first evaluator tick (see either sibling's own doc for
 * the exact hand arithmetic - 68.75 on tick 1, only 32 weighted points
 * scored in v1). Lives under `__tests__/` (not a standalone module) so
 * `scripts/check-tenant-scope.ts`'s `TEST_FILE_PATTERN` (keyed on the
 * literal `__tests__` path segment, NOT `__test-support__`) covers its raw,
 * unscoped `INSERT` statements - same rationale as `engine/pacing/__tests__/
 * pacing-test-helpers.ts`'s own header comment.
 */

export type TestPool = ReturnType<typeof createPool>;

export const EVALUATOR_FIXTURE_NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

/**
 * Floor for `primeInstanceToWatch`'s fake `send_attempts.message_job_id`
 * values (FIX-P26-D). The old base, `Math.floor(Math.random() *
 * 1_000_000_000) + 1_000_000`, ranged over [1e6, 1.001e9] - a range that
 * CONTAINS the real `message_jobs` bigserial (10,329,189 at the time of
 * run log row 26 in plan/v1/P26-scale-proof-1k.md). A 1k-send load run
 * then generated real job ids that collided with leftover fixture rows at
 * `attempt_no 1`, so the real dispatch INSERT's `ON CONFLICT DO NOTHING`
 * returned 0 rows, the job got stuck `processing` forever, and the run
 * silently produced no artifact after 105 minutes. 9e12 gives a bigserial
 * consuming 1,000,000 ids/day ~24,600 years of runway before it could ever
 * reach this floor, while staying comfortably under
 * `Number.MAX_SAFE_INTEGER` (9.007e15) so JS numbers and pg's bigint text
 * encoding stay exact.
 */
export const FAKE_JOB_ID_FLOOR = 9_000_000_000_000;

/** Pure so the [floor, floor + 1e9) range can be asserted without a real RNG. */
export function nextFakeJobIdBase(rng: () => number): number {
  return FAKE_JOB_ID_FLOOR + Math.floor(rng() * 1_000_000_000);
}

/** Same EWMA-priming trick both sibling suites use - forces WATCH on the very first tick. */
export function priorEvidenceAtSeverity(severity: number): Record<string, unknown> {
  return {
    rejected_send_rate: { severity },
    delivery_ratio: { severity },
  };
}

/**
 * Seeds `last_evidence` plus enough `send_attempts`/`message_jobs`/
 * `delivery_events` rows so `computeHealthScore` resolves EXACTLY: 20
 * attempted / 1 rejected (5%, fresh severity 1) and 40 sent / 22 delivered
 * (55%, fresh severity 0.875) - combined with a prior severity of 1.0 for
 * both scored signals, tick 1's smoothed score is exactly 68.75 (WATCH).
 */
export async function primeInstanceToWatch(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  nowMs: number,
): Promise<void> {
  await pool.query(`UPDATE instance_pacing_state SET last_evidence = $1 WHERE instance_id = $2`, [
    JSON.stringify(priorEvidenceAtSeverity(1.0)),
    instanceId,
  ]);

  // A large random base (>= FAKE_JOB_ID_FLOOR, see its own doc comment)
  // keeps this run's fake message_job_id values from colliding with any
  // other concurrently-running/leftover probe data OR the real message_jobs
  // bigserial - the (message_job_id, attempt_no) unique constraint has no
  // client_id scope.
  let nextFakeJobId = nextFakeJobIdBase(Math.random);
  for (let i = 0; i < 19; i += 1) {
    await pool.query(
      `INSERT INTO send_attempts (client_id, instance_id, message_job_id, message_job_created_at, attempt_no, state, dispatched_at)
       VALUES ($1, $2, $3, $4, 1, 'acked', $4)`,
      [clientId, instanceId, nextFakeJobId, new Date(nowMs - 60 * 60 * 1000)],
    );
    nextFakeJobId += 1;
  }
  await pool.query(
    `INSERT INTO send_attempts (client_id, instance_id, message_job_id, message_job_created_at, attempt_no, state, error_class, dispatched_at)
     VALUES ($1, $2, $3, $4, 1, 'failed', 'restricted', $4)`,
    [clientId, instanceId, nextFakeJobId, new Date(nowMs - 60 * 60 * 1000)],
  );

  for (let i = 0; i < 40; i += 1) {
    const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, is_new_conversation, sent_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 3, 'sent', now(), now(),
               1, 5, false, $5)
       RETURNING id`,
      [
        clientId,
        instanceId,
        recipientJid,
        JSON.stringify({ text: 'probe' }),
        new Date(nowMs - 60 * 60 * 1000),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('primeInstanceToWatch: message_jobs INSERT returned no row');
    if (i < 22) {
      // Reads message_jobs.created_at back via a subquery (never a JS Date
      // round-tripped through a RETURNING clause) - pg's driver decodes
      // timestamptz into a JS Date, which only has millisecond resolution
      // and silently truncates the column's microsecond precision, so a
      // parameter bound from that value fails the exact-equality JOIN
      // predicate health-signal-windows.sql uses (same "microsecond
      // round-trip bug" engine/queue/result.ts's own module doc warns
      // against for message_jobs predicates in application code).
      await pool.query(
        `INSERT INTO delivery_events (client_id, instance_id, message_job_id, message_job_created_at, event_type, created_at, provider_event_id)
         SELECT $1, $2, id, created_at, 'delivered', $3, $4 FROM message_jobs WHERE id = $5`,
        [
          clientId,
          instanceId,
          new Date(nowMs - 45 * 60 * 1000),
          `probe-delivered-${String(i)}-${randomUUID()}`,
          row.id,
        ],
      );
    }
  }
}
