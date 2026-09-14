/**
 * modules/events/cleanup.ts (P15 U4, step 5) - the relay's bounded retention
 * sweep. `outbox_events` is a drained WORK QUEUE, never a history table (see
 * migration 0041's own header) - once a row is published it exists only so
 * a slow consumer of the drain tick can be proven durable; after a fixed
 * grace window it is garbage. ADR 0010's cleanup rule: `DELETE ... WHERE
 * published_at < now() - interval '1 hour' LIMIT 5000` per tick - Postgres
 * `DELETE` has no `LIMIT` clause, so this uses the `WHERE id IN (SELECT ...
 * LIMIT 5000)` idiom (see `runOutboxCleanup`'s query below) to keep the
 * sweep bounded per tick, same "never an unbounded cross-tenant statement"
 * discipline as every other cron sweep in this repo.
 *
 * Deliberately deletes ONLY `published_at IS NOT NULL AND published_at <
 * cutoff` rows - an unpublished row (still eligible for `drainOnce` to
 * claim) can never be deleted here, and this module makes no judgement about
 * WHICH published rows to keep beyond the fixed age cutoff (no `suppressed_by`
 * special-case: a suppressed row's `published_at` is set at suppression time,
 * same column, same cutoff).
 */

export interface CleanupDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
  };
  /** Grace window before a published row becomes eligible for deletion - defaults to 1 hour (ADR 0010's literal rule). */
  retentionMs?: number;
  /** Bounded per-tick delete cap - defaults to 5000 (ADR 0010's literal rule). */
  limit?: number;
}

const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 5000;

/**
 * Runs one cleanup sweep as the `wp_relay` role (caller is responsible for
 * `SET LOCAL ROLE wp_relay` on `deps.pool`'s connection/transaction, same
 * convention as `drainOnce`). Returns the number of rows actually deleted
 * this tick (never more than `deps.limit`).
 */
export async function runOutboxCleanup(deps: CleanupDeps): Promise<number> {
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const limit = deps.limit ?? DEFAULT_LIMIT;

  const result = await deps.pool.query<{ id: string }>(
    `DELETE FROM outbox_events
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE published_at IS NOT NULL
           AND published_at < now() - ($1 || ' milliseconds')::interval
         ORDER BY id
         LIMIT $2
      )
    RETURNING id`,
    [retentionMs, limit],
  );

  return result.rows.length;
}
