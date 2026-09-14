import type { createPool } from '@wp/db';

/**
 * orphan-attempts-preflight.ts (FIX-P26-D) - a real-PG load run (e.g.
 * `run-pg-load.ts`) claims real `message_jobs.id` values off the
 * `message_jobs_id_seq` bigserial and inserts `send_attempts` rows keyed by
 * `(message_job_id, attempt_no)`. If a fixture (or any other prior process)
 * ever left orphan `send_attempts` rows in the small window the sequence is
 * about to walk through, the run's own `INSERT ... ON CONFLICT (message_job_
 * id, attempt_no) DO NOTHING RETURNING id` silently returns 0 rows for the
 * colliding job, which the dispatch path reads as `DispatchAlreadyRecorded`
 * - the job gets stuck `processing` forever and the run stalls for its full
 * duration with no artifact (run log row 26, plan/v1/P26-scale-proof-1k.md:
 * `evaluator-fixtures.ts`'s old fake-id range did exactly this). This module
 * is a READ-ONLY preflight: it refuses the run up front instead of letting
 * it stall.
 */

type Pool = ReturnType<typeof createPool>;

export interface OrphanAttemptLandmines {
  /** The `is_called`-adjusted EXCLUSIVE lower bound of the id window about to be issued - see `seqLowerBoundExclusive`'s own doc comment (MINOR h fix). */
  readonly seqLastValue: number;
  /** MINOR 1 fix (FIX-P26-I): the RAW (unadjusted) `last_value` the SQL's upper bound (`:82`) is actually computed from - carried separately so the printed window can match the scanned window exactly regardless of `is_called`. */
  readonly seqLastValueRaw: number;
  readonly idBudget: number;
  readonly count: number;
  readonly minJobId: number | null;
  readonly maxJobId: number | null;
  readonly distinctClients: number;
}

interface OrphanAttemptLandmineRow {
  seq_last_value: string;
  seq_is_called: boolean;
  count: string;
  min_job_id: string | null;
  max_job_id: string | null;
  distinct_clients: string;
}

/**
 * MINOR h fix (FIX-P26-H, 2026-09-07): `message_jobs_id_seq`'s `last_value`
 * alone is ambiguous - a sequence that has NEVER been called
 * (`is_called = false`, e.g. right after `CREATE SEQUENCE` or `ALTER
 * SEQUENCE ... RESTART`) reports its start value as `last_value`, but that
 * value has NOT yet been issued: the next `nextval()` call returns it. A
 * called sequence (`is_called = true`) has already issued `last_value`, so
 * the next call returns `last_value + 1`. The EXCLUSIVE lower bound of "ids
 * this sequence is about to walk through" is therefore `last_value - 1` when
 * `is_called = false` (so `> last_value - 1` includes `last_value` itself,
 * the next id to be issued), and plain `last_value` when `is_called = true`
 * (so `> last_value` excludes the already-issued value and starts at
 * `last_value + 1`, the next id to be issued).
 */
export function seqLowerBoundExclusive(seq: { lastValue: number; isCalled: boolean }): number {
  return seq.isCalled ? seq.lastValue : seq.lastValue - 1;
}

/**
 * MINOR 1 fix (FIX-P26-I): the SQL's upper bound (`:82`,
 * `a.message_job_id <= seq_last_value + $1`) always uses the RAW `last_value`
 * - it is never adjusted by `is_called`, unlike the lower bound. The window
 * printed in `OrphanAttemptLandmineError` must therefore add `idBudget` to
 * the RAW `last_value`, not to `seqLowerBoundExclusive`'s adjusted result,
 * or the message understates the scanned window by 1 whenever
 * `is_called = false`.
 */
export function seqUpperBoundInclusive(seq: { lastValue: number }, idBudget: number): number {
  return seq.lastValue + idBudget;
}

/**
 * Cross-tenant BY DESIGN (registered in
 * scripts/registries/cross-tenant-queries-p26.ts): an operator preflight has
 * no single tenant to scope to - it must see every orphan in the id window
 * regardless of which client_id fixture left it behind. Projects only ids/
 * counts (`projectedColumns` in the registry), never payload or recipient
 * columns.
 */
export async function readOrphanAttemptLandmines(
  pool: Pool,
  idBudget: number,
): Promise<OrphanAttemptLandmines> {
  const result = await pool.query<OrphanAttemptLandmineRow>(
    `WITH seq AS (SELECT last_value AS seq_last_value, is_called AS seq_is_called FROM message_jobs_id_seq)
     SELECT
       seq.seq_last_value::text AS seq_last_value,
       seq.seq_is_called AS seq_is_called,
       count(a.*)::text AS count,
       min(a.message_job_id)::text AS min_job_id,
       max(a.message_job_id)::text AS max_job_id,
       count(DISTINCT a.client_id)::text AS distinct_clients
     FROM seq
     LEFT JOIN send_attempts a
       ON a.message_job_id > (CASE WHEN seq.seq_is_called THEN seq.seq_last_value ELSE seq.seq_last_value - 1 END)
      AND a.message_job_id <= seq.seq_last_value + $1
      AND NOT EXISTS (SELECT 1 FROM message_jobs j WHERE j.id = a.message_job_id)
     GROUP BY seq.seq_last_value, seq.seq_is_called`,
    [idBudget],
  );
  const row = result.rows[0];
  if (!row) throw new Error('readOrphanAttemptLandmines: query returned no row');
  const seqLastValueRaw = Number(row.seq_last_value);
  return {
    // MINOR h fix: `seqLastValue` carries the `is_called`-ADJUSTED exclusive
    // lower bound (`seqLowerBoundExclusive`), matching the lower-bound CASE
    // in the JOIN above exactly. MINOR 1 fix: `seqLastValueRaw` carries the
    // UNADJUSTED value the JOIN's upper bound (`:97`) is actually computed
    // from, so the error message's printed window matches the scanned
    // window exactly for both `is_called` states (see `seqUpperBoundInclusive`).
    seqLastValue: seqLowerBoundExclusive({
      lastValue: seqLastValueRaw,
      isCalled: row.seq_is_called,
    }),
    seqLastValueRaw,
    idBudget,
    count: Number(row.count),
    minJobId: row.min_job_id === null ? null : Number(row.min_job_id),
    maxJobId: row.max_job_id === null ? null : Number(row.max_job_id),
    distinctClients: Number(row.distinct_clients),
  };
}

export class OrphanAttemptLandmineError extends Error {
  constructor(landmines: OrphanAttemptLandmines) {
    super(
      `orphan-attempts-preflight: found ${String(landmines.count)} orphan send_attempts ` +
        `row(s) across ${String(landmines.distinctClients)} client(s) inside the id window ` +
        `(${String(landmines.seqLastValue)}, ${String(seqUpperBoundInclusive({ lastValue: landmines.seqLastValueRaw }, landmines.idBudget))}] ` +
        `(message_job_id range [${String(landmines.minJobId)}, ${String(landmines.maxJobId)}]) that ` +
        `message_jobs_id_seq is about to walk through. The known writer of ` +
        `fake message_job_id values is modules/pacing/health/__tests__/evaluator-fixtures.ts ` +
        `- see run log row 26 (plan/v1/P26-scale-proof-1k.md): a real send would silently ` +
        `collide on (message_job_id, attempt_no), get read back as DispatchAlreadyRecorded, ` +
        `and stall in 'processing' forever. This run REFUSES to start rather than stall.`,
    );
    this.name = 'OrphanAttemptLandmineError';
  }
}

/** Throws `OrphanAttemptLandmineError` when landmines exist; otherwise returns the reading so the caller can record it in the run artifact's notes. */
export async function assertNoOrphanAttemptLandmines(
  pool: Pool,
  idBudget: number,
): Promise<OrphanAttemptLandmines> {
  const landmines = await readOrphanAttemptLandmines(pool, idBudget);
  if (landmines.count > 0) throw new OrphanAttemptLandmineError(landmines);
  return landmines;
}

/** Headroom for the driver's two-table enqueue (message_jobs + message_job_refs) and seeds - pure so it's exact-value testable. */
export function idBudgetForRun(input: { sends: number; instances: number }): number {
  return input.sends * 2 + input.instances * 2;
}
