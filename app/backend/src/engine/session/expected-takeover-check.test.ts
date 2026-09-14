import { describe, expect, it, vi } from 'vitest';
import { TIMING } from '@wp/domain';
import {
  isExpectedTakeover,
  checkExpectedTakeover,
  buildExpectedTakeoverCheck,
  type ExpectedTakeoverQueryable,
} from './expected-takeover-check.js';

const WINDOW_MS = TIMING.leaseTtlMs + TIMING.takeoverGraceMs;

describe('isExpectedTakeover', () => {
  it('returns false when there is no lease-state row', () => {
    expect(isExpectedTakeover(null, { myFence: 1n })).toBe(false);
  });

  it('returns false when lease_seen_at is null (never minted)', () => {
    expect(isExpectedTakeover({ currentFence: 5n, leaseSeenAt: null }, { myFence: 1n })).toBe(
      false,
    );
  });

  it('returns false when the current fence is not strictly higher than myFence', () => {
    const now = 1_000_000;
    expect(
      isExpectedTakeover(
        { currentFence: 1n, leaseSeenAt: new Date(now) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(false);
    expect(
      isExpectedTakeover(
        { currentFence: 0n, leaseSeenAt: new Date(now) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(false);
  });

  it('returns true for a higher fence minted just now (age 0)', () => {
    const now = 1_000_000;
    expect(
      isExpectedTakeover(
        { currentFence: 2n, leaseSeenAt: new Date(now) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(true);
  });

  it('returns true for a higher fence minted right at the window edge', () => {
    const mintedAt = 1_000_000;
    const now = mintedAt + WINDOW_MS;
    expect(
      isExpectedTakeover(
        { currentFence: 2n, leaseSeenAt: new Date(mintedAt) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(true);
  });

  it('returns false once the window has elapsed', () => {
    const mintedAt = 1_000_000;
    const now = mintedAt + WINDOW_MS + 1;
    expect(
      isExpectedTakeover(
        { currentFence: 2n, leaseSeenAt: new Date(mintedAt) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(false);
  });

  it('returns false when lease_seen_at is in the future relative to now (clock skew)', () => {
    const mintedAt = 1_000_000;
    const now = mintedAt - 1;
    expect(
      isExpectedTakeover(
        { currentFence: 2n, leaseSeenAt: new Date(mintedAt) },
        { myFence: 1n },
        { now: () => now },
      ),
    ).toBe(false);
  });

  it('respects an injected windowMs override', () => {
    const mintedAt = 1_000_000;
    const now = mintedAt + 10;
    expect(
      isExpectedTakeover(
        { currentFence: 2n, leaseSeenAt: new Date(mintedAt) },
        { myFence: 1n },
        { now: () => now, windowMs: 5 },
      ),
    ).toBe(false);
  });
});

describe('checkExpectedTakeover', () => {
  function fakeSql(rows: Record<string, unknown>[]): ExpectedTakeoverQueryable {
    return { query: vi.fn().mockResolvedValue({ rows }) };
  }

  it('resolves false when the query returns no row', async () => {
    const sql = fakeSql([]);
    const result = await checkExpectedTakeover(sql, {
      instanceId: 'i1',
      clientId: 'c1',
      myFence: 1n,
    });
    expect(result).toBe(false);
  });

  it('resolves true for a fresh, higher-fence row', async () => {
    const now = 2_000_000;
    const sql = fakeSql([{ current_fence: '3', lease_seen_at: new Date(now) }]);
    const result = await checkExpectedTakeover(
      sql,
      { instanceId: 'i1', clientId: 'c1', myFence: 1n },
      { now: () => now },
    );
    expect(result).toBe(true);
  });

  it('resolves false for a same/lower fence row', async () => {
    const now = 2_000_000;
    const sql = fakeSql([{ current_fence: '1', lease_seen_at: new Date(now) }]);
    const result = await checkExpectedTakeover(
      sql,
      { instanceId: 'i1', clientId: 'c1', myFence: 1n },
      { now: () => now },
    );
    expect(result).toBe(false);
  });
});

describe('buildExpectedTakeoverCheck', () => {
  it('binds withTenant and returns the predicate result', async () => {
    const now = 3_000_000;
    const sql = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ current_fence: '9', lease_seen_at: new Date(now) }] }),
    };
    const withTenant = vi.fn((_clientId: string, fn: (s: typeof sql) => Promise<unknown>) =>
      fn(sql),
    ) as Parameters<typeof buildExpectedTakeoverCheck>[0]['withTenant'];

    const check = buildExpectedTakeoverCheck({ withTenant, now: () => now });
    const result = await check('i1', 'c1', 1n);

    expect(withTenant).toHaveBeenCalledWith('c1', expect.any(Function));
    expect(result).toBe(true);
  });

  it('resolves false (never throws) when withTenant/query rejects', async () => {
    const onError = vi.fn();
    const withTenant = vi.fn().mockRejectedValue(new Error('pg down'));

    const check = buildExpectedTakeoverCheck({ withTenant, onError });
    const result = await check('i1', 'c1', 1n);

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
