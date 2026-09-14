import { describe, expect, it, vi } from 'vitest';
import { resolvePlanId } from './clients-plan.js';
import { InternalTargetNotFoundError } from './internal-errors.js';

/**
 * clients-plan.test.ts (C1 review round 2 MINOR fix) - `resolvePlanId` is
 * the ONE lookup `PUT clients/:id/plan` uses to turn a `planKey` into a
 * `plans.id` BEFORE writing `clients.plan_id` - an unseeded key must 404,
 * never silently write NULL. Pure unit test (fake `tx.query`), because the
 * real `plans` catalog rows (`starter`/`growth`/`business`, migration 0070)
 * are shared, global, non-tenant-scoped rows every other integration test
 * in this suite also reads - deleting/renaming one for a real-DB test would
 * make this file unsafe to run in parallel with the rest of the suite.
 */

function fakeTx(rows: Array<{ id: string }>) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('resolvePlanId', () => {
  it('returns_the_plans_id_for_a_seeded_key', async () => {
    const tx = fakeTx([{ id: 'plan-row-1' }]);
    const id = await resolvePlanId(tx, 'growth');
    expect(id).toBe('plan-row-1');
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT\s+id\s+FROM\s+plans\s+WHERE\s+key\s*=\s*\$1/i);
    expect(params).toEqual(['growth']);
  });

  it('throws_InternalTargetNotFoundError_for_an_unseeded_key', async () => {
    const tx = fakeTx([]);
    await expect(resolvePlanId(tx, 'business')).rejects.toBeInstanceOf(InternalTargetNotFoundError);
  });
});
