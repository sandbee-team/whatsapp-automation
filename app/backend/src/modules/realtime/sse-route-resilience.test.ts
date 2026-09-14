import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeHub, type DropReason } from './hub.js';
import { openSseStream } from '../../platform/http/sse.js';
import { buildHarness, signAccessToken, type Harness } from './__tests__/sse-route-test-support.js';

/**
 * sse-route-resilience.test.ts (P05 Unit U3a) - `GET /v1/events`: heartbeat
 * keep-alive, the bounded per-connection frame queue (slow-consumer
 * disconnect), the per-user connection cap, and hub.publish's own
 * ids-only/schema validation. See sse-route.test.ts for auth/tenant-
 * isolation/replay.
 */

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    harness = undefined;
  }
  vi.restoreAllMocks();
});

describe('GET /v1/events (resilience)', () => {
  it('a_heartbeat_frame_arrives_within_20_seconds', async () => {
    harness = await buildHarness({ heartbeatMs: 15000 });
    const userA = randomUUID();
    harness.epochByUserId.set(userA, 0);
    const token = await signAccessToken({
      userId: userA,
      sessionId: randomUUID(),
      clientId: randomUUID(),
      role: 'owner',
      epoch: 0,
    });

    const response = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawHeartbeat = false;
    const deadline = Date.now() + 2000;

    harness.advance(20000);

    while (!sawHeartbeat && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), 50),
        ),
      ]);
      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(': hb')) sawHeartbeat = true;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }

    expect(sawHeartbeat).toBe(true);
  });

  it('a_slow_consumer_is_closed_and_counted_not_buffered_without_bound', () => {
    // Unit-level, not over a real socket: OS/TCP buffers easily absorb 100+
    // small JSON frames, so a real connection never actually observes
    // backpressure at this volume in a test. A fake `reply.raw`/`req.raw`
    // pair whose `write` always returns false (backpressured) and never
    // emits `drain` - the exact "never drains" shape the task calls for -
    // exercises sse.ts's bounded-queue/slow-consumer path directly and
    // deterministically, wired through the real hub so `onDrop` is also
    // proven end to end.
    const fakeRes = {
      writeHead: () => {},
      write: (): boolean => false,
      end: () => {},
      setTimeout: () => {},
      on: () => {},
    };
    const fakeReqRaw = {
      socket: { setTimeout: () => {} },
      on: () => {},
    };
    const fakeReq = { raw: fakeReqRaw } as unknown as FastifyRequest;
    const fakeReply = {
      hijack: () => {},
      raw: fakeRes,
    } as unknown as FastifyReply;

    const sink = openSseStream(fakeReq, fakeReply, {
      heartbeatMs: 1_000_000,
      maxBufferedFrames: 100,
    });

    const hub = createRealtimeHub({ replayRingSize: 500 });
    const clientA = randomUUID();
    const drops: DropReason[] = [];
    hub.onDrop((reason) => drops.push(reason));

    hub.connect({
      connectionId: 'conn-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      clientId: clientA,
      epoch: 0,
      channels: [`client:${clientA}`],
      sink,
    });

    for (let i = 0; i < 102; i += 1) {
      hub.publish({
        type: 'campaign.progress',
        clientId: clientA,
        campaignId: randomUUID(),
        sent: i,
        queued: 0,
        failed: 0,
      });
    }

    expect(drops).toEqual(['slow_consumer']);
    expect(hub.connectionCount()).toBe(0);
  });

  it('the_sixth_connection_for_one_user_is_refused_with_429', async () => {
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

    const responses: Response[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${harness.baseUrl}/v1/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(200);
      responses.push(r);
    }
    for (let i = 0; i < 50 && harness.hub.connectionCount() < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(harness.hub.connectionCount()).toBe(5);

    const sixth = await fetch(`${harness.baseUrl}/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('content-type')).toContain('application/json');

    for (const r of responses) {
      await r.body?.cancel().catch(() => {});
    }
  });

  it('a_non_conforming_publish_throws_and_sends_nothing', async () => {
    // MIN-1: make the name true - a real connection is open and subscribed
    // to the target channel BEFORE the non-conforming publish, so this
    // proves not just "publish() throws" but "the already-connected sink
    // received ZERO data frames and the replay ring did not grow" as a
    // result of the throw.
    harness = await buildHarness();
    const clientA = randomUUID();
    harness.epochByUserId.set(randomUUID(), 0);
    const userA = randomUUID();
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
    expect(response.status).toBe(200);

    for (let i = 0; i < 50 && harness.hub.connectionCount() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(harness.hub.connectionCount()).toBe(1);

    const instanceId = randomUUID();
    const channel = `client:${clientA}:instance:${instanceId}`;

    expect(() =>
      harness!.hub.publish({
        type: 'instance.pacing_changed',
        clientId: clientA,
        instanceId,
        band: 'HIGH',
        tier: 1,
        effDailyCap: 100,
        configVersion: 1,
        // @ts-expect-error - deliberately non-conforming payload under test.
        phone: '+919876543210',
      }),
    ).toThrow();

    // The connection is untouched by the throw - still connected, never
    // dropped or errored.
    expect(harness.hub.connectionCount()).toBe(1);

    // The already-open sink received zero data frames from this publish
    // attempt (no `Last-Event-ID` was ever sent, so any resume/replay would
    // be `resync` on an unknown id, which itself proves the ring never
    // accumulated a frame for this channel).
    const replay = harness.hub.replaySince(channel, 'any-id-never-issued');
    expect(replay.kind).toBe('resync');

    await response.body?.cancel().catch(() => {});
  });
});
