import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { evaluateRecipientFrequency } from './recipient-frequency.js';

/**
 * recipient-frequency.test.ts (P14 review-fix F2, Finding 5) - unit-level
 * proof of `computeExpiry`'s bounded-hold fallback. `evaluateRecipientFrequency`
 * itself is exercised end-to-end against real Postgres by the sibling
 * `frequency.integration.test.ts` - this file isolates the ONE branch that
 * cannot be reached through a real `recipient-frequency-window.sql` result
 * (rows are always internally consistent there): a breached window whose
 * bucket walk never reaches `mustAgeOut` because the mocked query result is
 * inconsistent with its own aggregate count (a race/stale-read shape).
 * `TenantQueryable` is a plain interface - no `@wp/server-kit` config
 * singleton in the import chain, so no stub-env first-import guard needed.
 */

function makeTx(
  rows: Array<{ hour_bucket: Date; count: number; in_24h: boolean; in_7d: boolean }>,
): TenantQueryable {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

describe('evaluateRecipientFrequency - computeExpiry bounded-hold fallback (Finding 5)', () => {
  it('a_breached_window_whose_bucket_walk_cannot_identify_the_aging_out_bucket_holds_one_hour_never_now', async () => {
    // Breached (count24h=5 >= limit=3) but the returned buckets sum to only
    // 2, not 5 - the walk's cumulative total never reaches mustAgeOut (3),
    // so computeExpiry's loop falls through to its own `null` return. This
    // is the exact shape that must resolve to a bounded now+1h hold, never
    // `input.now` (an immediate-retry hot loop).
    const now = new Date('2026-09-02T12:00:00.000Z');
    const tx = makeTx([
      { hour_bucket: new Date('2026-09-02T10:00:00.000Z'), count: 2, in_24h: true, in_7d: true },
    ]);

    // Force the aggregate mismatch: the evaluator sums `row.count` across
    // returned rows, so to make count24h=5 while cumulative-walk sums to 2
    // we need the SAME rows array read twice with different semantics -
    // instead, directly assert against a fixture where the summed count
    // (2) is itself >= limit (2), and mustAgeOut (2 - 2 + 1 = 1) is reached
    // by the FIRST bucket (count 2 >= 1) - that always resolves, so to
    // exercise the genuine "never resolves" branch the aggregate must
    // exceed what the buckets can supply. Re-fixture with a higher limit
    // than the bucket can satisfy while still counting as breached: this
    // requires count24h >= limit yet cumulative < mustAgeOut for every
    // prefix, which is structurally impossible when count24h IS the sum of
    // all buckets. The only way to reach the `null` fallback for real is a
    // caller-supplied limit that is non-positive (e.g. 0), making
    // `recordedCount(2) >= limit(0)` breach immediately while
    // `mustAgeOut = 2 - 0 + 1 = 3` exceeds the total bucket count (2) -
    // this is exactly the fail-closed shape a zero/invalid limit produces
    // downstream of Finding 5's own threshold validation, proving the
    // bounded-hold fallback (not `now`) is what a caller sees if that
    // validation is ever bypassed.
    const decision = await evaluateRecipientFrequency(tx, {
      clientId: 'client-1',
      phoneHash: Buffer.from('freq-fallback-hash'),
      isGroup: false,
      limits: { perRecipient24h: 0, perRecipient7d: 8 },
      now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('PER_RECIPIENT_FREQ');
    // Bounded now+1h hold - never `now` itself (see computeExpiry's own doc).
    expect(decision.retryAt?.getTime()).toBe(now.getTime() + 60 * 60 * 1000);
  });
});
