import { describe, expect, it, vi } from 'vitest';
import { markDirty } from './dirty-set.js';

/**
 * dirty-set.test.ts (P16 Unit E, step 9) - `markDirty` is the ONLY function
 * the fast-lane/send-outcome/connection-update seams call to force an
 * instance back onto tier 1 (60s) of the health evaluator's due-scan ladder.
 * Proves the exact statement shape (idempotent conditional-free UPDATE,
 * client_id + instance_id scoped) and its two written values.
 */

function fakeSql(rowCount = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount });
  return { query };
}

describe('markDirty', () => {
  it('sets_eval_due_at_to_now_and_eval_tier_to_one_scoped_to_client_and_instance', async () => {
    const sql = fakeSql();

    await markDirty(sql, { clientId: 'client-1', instanceId: 'instance-1' });

    expect(sql.query).toHaveBeenCalledTimes(1);
    const [text, params] = sql.query.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/UPDATE\s+instance_pacing_state/i);
    expect(text).toMatch(/eval_due_at\s*=\s*now\(\)/i);
    expect(text).toMatch(/eval_tier\s*=\s*1/);
    expect(text).toMatch(/WHERE/i);
    expect(text).toMatch(/instance_id\s*=\s*\$1/i);
    expect(text).toMatch(/client_id\s*=\s*\$2/i);
    expect(params).toEqual(['instance-1', 'client-1']);
  });
});
