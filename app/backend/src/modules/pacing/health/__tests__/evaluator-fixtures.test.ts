import { describe, expect, it } from 'vitest';
import { FAKE_JOB_ID_FLOOR, nextFakeJobIdBase } from './evaluator-fixtures.js';

/**
 * evaluator-fixtures.test.ts (FIX-P26-D) - pure unit test for
 * `nextFakeJobIdBase`, the helper that replaced the old
 * `Math.floor(Math.random() * 1_000_000_000) + 1_000_000` base in
 * `primeInstanceToWatch`. That old range ([1e6, 1.001e9]) overlapped the
 * real `message_jobs` bigserial (10,329,189 at time of writing) - see run
 * log row 26 in plan/v1/P26-scale-proof-1k.md. Asserts the new base is
 * always >= FAKE_JOB_ID_FLOOR (9e12, ~24,600 years of runway at 1M
 * ids/day) and always < Number.MAX_SAFE_INTEGER, at both ends of the rng
 * range.
 */
describe('nextFakeJobIdBase', () => {
  it('floors at FAKE_JOB_ID_FLOOR when rng returns 0', () => {
    expect(nextFakeJobIdBase(() => 0)).toBe(FAKE_JOB_ID_FLOOR);
  });

  it('stays below Number.MAX_SAFE_INTEGER when rng returns its max (0.999...)', () => {
    const base = nextFakeJobIdBase(() => 0.999_999_999);
    expect(base).toBe(FAKE_JOB_ID_FLOOR + 999_999_999);
    expect(base).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(base).toBeGreaterThanOrEqual(FAKE_JOB_ID_FLOOR);
  });
});
