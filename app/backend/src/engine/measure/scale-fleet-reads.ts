import type { createPool } from '@wp/db';

/**
 * scale-fleet-reads.ts (P26) - the fleet's own Postgres READS, split out of
 * `scale-fleet.ts` purely for that file's `max-lines` cap (same mechanical
 * idiom as `scale-fleet-takeover.ts`). Pure code motion plus the tenant
 * predicate below - no new module boundary.
 *
 * TENANT SCOPING (invariant 4): every read here is scoped to the tenants
 * `createScaleFleet#start()` itself seeded, via `client_id = ANY($2)` next to
 * the instance-id predicate - never a fleet-wide read of a shared table. A
 * measurement harness sharing Postgres with a live run (P26 ran a 1,000-
 * instance load and a 7-day drift against the same database) MUST NOT read
 * another run's lease rows, and saying so in SQL is what makes that true.
 */

/** `instance_id -> owner_worker_id` for this fleet's own instances, scoped to its own tenants. */
export async function readOwnerMap(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<Map<string, string>> {
  if (instanceIds.length === 0 || clientIds.length === 0) return new Map();
  const result = await pool.query<{ instance_id: string; owner_worker_id: string }>(
    `SELECT instance_id, owner_worker_id FROM instance_lease_state
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return new Map(result.rows.map((r) => [r.instance_id, r.owner_worker_id]));
}
