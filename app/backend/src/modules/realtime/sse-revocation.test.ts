import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { createRealtimeHub, type DropReason } from './hub.js';
import { createAuthzTick } from './authz-tick.js';

/**
 * sse-revocation.test.ts (P05 Unit U3b) - THE PHASE DEMO: fake timers +
 * `createAuthzTick#start()` driving the real hub end to end, proving the
 * blueprint's "a revoked membership drops the socket within 5 seconds"
 * [R-35] against a fake db whose rows are mutated between ticks (exactly
 * the shape a real membership DELETE / token_epoch bump would produce
 * across successive tick queries).
 */

interface FakeSink {
  closed: boolean;
  closeReason: DropReason | undefined;
}

function connectFakeSink(
  hub: ReturnType<typeof createRealtimeHub>,
  input: { connectionId: string; userId: string; clientId: string; epoch: number },
): FakeSink {
  const sink: FakeSink = { closed: false, closeReason: undefined };
  const closeCallbacks: Array<(reason: DropReason) => void> = [];
  hub.connect({
    connectionId: input.connectionId,
    userId: input.userId,
    sessionId: randomUUID(),
    clientId: input.clientId,
    epoch: input.epoch,
    channels: [`client:${input.clientId}`],
    sink: {
      write: () => {},
      comment: () => {},
      close: (reason) => {
        if (sink.closed) return;
        sink.closed = true;
        sink.closeReason = reason;
        for (const cb of closeCallbacks) cb(reason);
      },
      onClose: (cb) => {
        closeCallbacks.push(cb);
      },
    },
  });
  return sink;
}

interface FakeRow {
  userId: string;
  tokenEpoch: number;
  clientId: string | null;
  clientStatus: string | null;
}

function fakeDbFromRows(rowsByUserId: Map<string, FakeRow>): TenantQueryable {
  return {
    query: (async (_sql: string, params?: unknown[]) => {
      const userIds = (params?.[0] as readonly string[] | undefined) ?? [];
      const rows = userIds
        .map((id) => rowsByUserId.get(id))
        .filter((r): r is FakeRow => r !== undefined)
        .map((r) => ({
          user_id: r.userId,
          token_epoch: r.tokenEpoch,
          client_id: r.clientId,
          client_status: r.clientStatus,
        }));
      return { rows, rowCount: rows.length };
    }) as TenantQueryable['query'],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SSE re-authorisation tick (fake timers, THE PHASE DEMO)', () => {
  it('a_revoked_membership_drops_the_stream_within_5_seconds', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientX = randomUUID();
    const userA = randomUUID();

    const rowsByUserId = new Map<string, FakeRow>([
      [userA, { userId: userA, tokenEpoch: 0, clientId: clientX, clientStatus: 'active' }],
    ]);
    const db = fakeDbFromRows(rowsByUserId);

    const drops: DropReason[] = [];
    hub.onDrop((reason) => drops.push(reason));

    const sinkA = connectFakeSink(hub, {
      connectionId: randomUUID(),
      userId: userA,
      clientId: clientX,
      epoch: 0,
    });

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });
    tick.start();

    // A's membership is removed server-side.
    rowsByUserId.delete(userA);

    await vi.advanceTimersByTimeAsync(5000);

    expect(sinkA.closed).toBe(true);
    expect(sinkA.closeReason).toBe('membership_revoked');
    expect(drops.filter((r) => r === 'membership_revoked')).toHaveLength(1);

    tick.stop();
  });

  it('a_token_epoch_bump_drops_the_stream_within_5_seconds', async () => {
    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientX = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();

    const rowsByUserId = new Map<string, FakeRow>([
      [userA, { userId: userA, tokenEpoch: 0, clientId: clientX, clientStatus: 'active' }],
      [userB, { userId: userB, tokenEpoch: 0, clientId: clientX, clientStatus: 'active' }],
    ]);
    const db = fakeDbFromRows(rowsByUserId);

    const drops: DropReason[] = [];
    hub.onDrop((reason) => drops.push(reason));

    // 3 tabs for userA.
    const sinksA = [
      connectFakeSink(hub, {
        connectionId: randomUUID(),
        userId: userA,
        clientId: clientX,
        epoch: 0,
      }),
      connectFakeSink(hub, {
        connectionId: randomUUID(),
        userId: userA,
        clientId: clientX,
        epoch: 0,
      }),
      connectFakeSink(hub, {
        connectionId: randomUUID(),
        userId: userA,
        clientId: clientX,
        epoch: 0,
      }),
    ];
    const sinkB = connectFakeSink(hub, {
      connectionId: randomUUID(),
      userId: userB,
      clientId: clientX,
      epoch: 0,
    });

    const tick = createAuthzTick({
      hub,
      db,
      tickMs: 5000,
      maxConsecutiveFailures: 6,
      metrics: { incrementAuthzTickErrors: () => {} },
      logger: { info: () => {}, error: () => {} },
    });
    tick.start();

    // userA's epoch bumps server-side (logout/role change/etc).
    rowsByUserId.set(userA, {
      userId: userA,
      tokenEpoch: 1,
      clientId: clientX,
      clientStatus: 'active',
    });

    await vi.advanceTimersByTimeAsync(5000);

    for (const sink of sinksA) {
      expect(sink.closed).toBe(true);
      expect(sink.closeReason).toBe('token_epoch');
    }
    expect(drops.filter((r) => r === 'token_epoch')).toHaveLength(3);

    // userB unaffected.
    expect(sinkB.closed).toBe(false);

    tick.stop();
  });
});
