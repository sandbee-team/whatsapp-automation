import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHarness, signAccessToken, type Harness } from './__tests__/sse-route-test-support.js';
import { TooManyConnectionsError, type RealtimeHub } from './hub.js';

/**
 * sse-route-connection-cap.test.ts (P05 FIXA MAJ-3) - split out of
 * sse-route-resilience.test.ts (workspace's 300-line max-lines lint rule):
 * the per-user connection cap's TOCTOU race under genuinely concurrent
 * (no-await-between) requests, which the pre-hijack fast-path check alone
 * cannot close - only `hub.connect`'s own atomic check can.
 */

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    harness = undefined;
  }
  vi.restoreAllMocks();
});

describe('GET /v1/events (connection cap TOCTOU)', () => {
  it('ten_concurrent_connect_requests_for_one_user_never_exceed_the_cap_even_when_fired_without_awaiting', async () => {
    // MAJ-3: firing all 10 requests WITHOUT awaiting between them (unlike
    // the sequential "sixth connection" test in sse-route-resilience.test.ts)
    // exercises the exact TOCTOU shape the pre-hijack `assertUnderConnectionCap`
    // check alone cannot close - the hub-level atomic check inside
    // `hub.connect` is the real authority regardless of how much (if any)
    // async work happens between a request's own pre-hijack check and its
    // own `hub.connect` call, and regardless of how many OTHER concurrent
    // requests interleave in between.
    harness = await buildHarness({ maxConnectionsPerUser: 5 });
    const userA = randomUUID();
    const clientA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${harness!.baseUrl}/v1/events`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    );

    for (let i = 0; i < 50 && harness.hub.connectionCount() < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The hub's own registered count is the real authority: regardless of
    // how the 10 responses split between 200 (accepted) and 429 (refused
    // pre-hijack) at the HTTP layer, the number of connections the hub ever
    // actually holds for this user must never exceed the cap.
    expect(harness.hub.connectionCount()).toBeLessThanOrEqual(5);

    const statuses = responses.map((r) => r.status);
    const okCount = statuses.filter((s) => s === 200).length;
    const refusedCount = statuses.filter((s) => s === 429).length;
    expect(okCount).toBeLessThanOrEqual(5);
    expect(okCount + refusedCount).toBe(10);

    for (const r of responses) {
      await r.body?.cancel().catch(() => {});
    }
  });

  it('a_post_hijack_hub_connect_refusal_closes_the_just_opened_stream_cleanly_with_connection_cap', async () => {
    // MAJ-3: even when the pre-hijack `assertUnderConnectionCap` fast-path
    // check passes (reads a count under the cap), `hub.connect` itself is
    // the atomic authority and can still refuse - once the stream is
    // already hijacked, that refusal can no longer become a plain JSON 429,
    // so routes.ts must instead close the just-opened stream cleanly with
    // drop reason 'connection_cap' rather than leave the client hanging on
    // a stream that will never receive a frame or an end. A hub stub whose
    // `connect` unconditionally throws forces this exact path
    // deterministically, without needing to win a real concurrency race.
    const fakeHub: RealtimeHub = {
      connect: () => {
        throw new TooManyConnectionsError();
      },
      subscribeChannel: () => {},
      disconnect: () => {},
      publish: () => {},
      connectionsForUser: () => [],
      distinctUserIds: () => [],
      connectionCount: () => 0,
      dropWhere: () => 0,
      closeAll: () => {},
      onDrop: () => {},
      onConnectionCountChange: () => {},
      replaySince: () => ({ kind: 'resync' }),
    };

    harness = await buildHarness({ hubOverride: fakeHub });
    const userA = randomUUID();
    const clientA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: clientA,
      role: 'owner',
      epoch: 0,
    });

    const response = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Headers were already flushed by `openSseStream` before `hub.connect`
    // ever ran - status is 200 regardless of the post-hijack refusal.
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const outcome = await Promise.race([
      reader.read().then((chunk): 'ended' | 'has_data' => (chunk.done ? 'ended' : 'has_data')),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 1000)),
    ]);
    await reader.cancel().catch(() => {});

    expect(outcome).toBe('ended');
  });
});
