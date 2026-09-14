import { loadQuery } from '@wp/db';

/**
 * retention.ts (P16 Unit E, step 10 - closing Unit A's own reported wiring
 * gap) - the bounded 30-day retention sweep for `instance_health_samples`
 * (`db/queries/health-samples-retention.sql`, migration 0044). Mirrors
 * `modules/events/cleanup.ts#runOutboxCleanup` exactly: cross-tenant,
 * bounded (`WHERE id IN (SELECT ... LIMIT $2)`) DELETE, never unbounded -
 * registered in `scripts/registries/cross-tenant-queries.ts` under
 * `"db/queries/health-samples-retention.sql:(module scope)"` (the file
 * carries no `-- name:` marker).
 *
 * Positional binds ($1 = retention ms, $2 = per-tick limit) - the query file
 * uses digit-only `$1`/`$2` placeholders, which `@wp/db`'s `loadQuery` named-
 * param converter leaves untouched (it only rewrites `$name`-shaped
 * placeholders), so this caller binds the positional array directly rather
 * than going through `bindQueryParams`.
 */

export interface HealthSamplesRetentionDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
  };
  /** Grace window before a sample becomes eligible for deletion - defaults to 30 days (migration 0044's own literal). */
  retentionMs?: number;
  /** Bounded per-tick delete cap - defaults to 5000, same cap class as `runOutboxCleanup`'s own default. */
  limit?: number;
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 5000;

/** Runs one cleanup sweep as the caller's own role (same "caller is responsible for SET LOCAL ROLE" convention as `runOutboxCleanup`/`drainOnce`). Returns the number of rows actually deleted this tick (never more than `deps.limit`). */
export async function runHealthSamplesCleanup(deps: HealthSamplesRetentionDeps): Promise<number> {
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const limit = deps.limit ?? DEFAULT_LIMIT;

  const query = await loadQuery('health-samples-retention');
  const result = await deps.pool.query<{ id: string }>(query.text, [retentionMs, limit]);

  return result.rows.length;
}
