import type { AdminAppQueryable } from '../staff-audit.js';
import { InternalTargetNotFoundError } from './internal-errors.js';

/**
 * routes/clients-plan.ts (C1 review round 2 MINOR fix) - `resolvePlanId`,
 * split out of `clients.ts` so it is independently unit-testable against a
 * fake `tx` without touching the shared, non-tenant-scoped `plans` catalog
 * rows (see `clients-plan.test.ts`'s own header). `PUT clients/:id/plan`
 * previously wrote `plan_id = (SELECT id FROM plans WHERE key = $2)` inline
 * in the UPDATE - for a `planKey` with no matching row (structurally
 * impossible today since the schema's enum matches migration 0070's seed,
 * but not guaranteed forever) that subquery silently resolves to NULL and
 * the UPDATE still matches the client row, so `rowCount > 0` and the caller
 * never learns `plan_id` was just cleared. Resolving the id FIRST, with a
 * hard 404 on no match, makes an unseeded key fail closed instead.
 */

export async function resolvePlanId(tx: AdminAppQueryable, planKey: string): Promise<string> {
  const result = await tx.query<{ id: string }>(`SELECT id FROM plans WHERE key = $1`, [planKey]);
  const row = result.rows[0];
  if (!row) {
    throw new InternalTargetNotFoundError('No such plan.');
  }
  return row.id;
}
