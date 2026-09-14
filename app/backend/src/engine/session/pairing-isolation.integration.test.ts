import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createRealtimeHub } from '../../modules/realtime/hub.js';
import {
  pool,
  probeClientIds,
  makeFakeSock,
  makeClock,
  makeFakeTimerScheduler,
  seedProbe,
  buildRunner,
  type PublishedEvent,
} from './runner-test-support.js';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';

/**
 * pairing-isolation.integration.test.ts (P08 U5b, TEST 1) - proves the QR
 * bearer credential (`instance.qr`'s `payload` field, @wp/contracts'
 * realtime.ts doc comment: "ONE sink... never logged, metriced, or written
 * to audit metadata") is published ONLY on the owning tenant's channel, and
 * is never persisted anywhere in Redis - the pub/sub frame is its only
 * carrier. Uses the REAL `createRealtimeHub` (modules/realtime/hub.ts) - an
 * in-process fan-out hub with NO Redis pub/sub leg of its own (see that
 * file's own header: "there is no Postgres LISTEN connection here and no
 * outbox yet... a future multi-process fan-out replaces this with Redis
 * pub/sub"). Redis in this test is therefore the REAL Redis the lease
 * machinery underneath the runner actually touches (instance_lease_state's
 * Redis leg) - proven empty of the qr string by a full keyspace enumeration,
 * not by asserting against a Redis channel the hub does not use.
 */

type TestRedis = ReturnType<typeof createRedis>;

let redis: TestRedis;

beforeAll(() => {
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds.length = 0;
});

describe('QR pairing publishes only on the owning tenant channel', () => {
  it('qr_is_published_only_on_the_owning_tenant_channel', async () => {
    const qrPayload = `qr-secret-${randomUUID()}`;

    const hub = createRealtimeHub({ replayRingSize: 50 });

    // Tenant A owns the pairing instance under test.
    const { clientId: clientA, instanceId } = await seedProbe();
    // Tenant B is a completely unrelated tenant - its own instance, never
    // subscribed to anything of A's.
    const { clientId: clientB, instanceId: instanceB } = await seedProbe();

    const framesA: { event: string; data: string }[] = [];
    const framesB: { event: string; data: string }[] = [];

    // A's subscriber: connected to A's own instance channel (the real
    // channel shape hub.ts's publish() computes: `client:{clientId}:instance:{instanceId}`).
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId: clientA,
      epoch: 0,
      channels: [`client:${clientA}:instance:${instanceId}`],
      sink: {
        write: (frame) => framesA.push({ event: frame.event, data: frame.data }),
        comment: () => {},
        close: () => {},
        onClose: () => {},
      },
    });

    // B's subscriber: subscribed only to B's OWN instance channel via the
    // hub's real subscribe path - never to A's channel, never to A's instance.
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId: clientB,
      epoch: 0,
      channels: [`client:${clientB}:instance:${instanceB}`],
      sink: {
        write: (frame) => framesB.push({ event: frame.event, data: frame.data }),
        comment: () => {},
        close: () => {},
        onClose: () => {},
      },
    });

    const publish = vi.fn((event: PublishedEvent) => hub.publish(event as never));

    const sock = makeFakeSock();
    const clock = makeClock(0);
    const scheduler = makeFakeTimerScheduler();

    const built = buildRunner({
      sock,
      fence: 1n,
      clock,
      scheduler,
      clientId: clientA,
      publish,
      instanceId,
    });
    built.instanceIdHolderSet(instanceId);

    const startResult = await built.runner.start({ instanceId, clientId: clientA });
    expect(startResult).not.toBe('not_acquired');

    // Drive a full fake-socket pairing run: one QR event through the real
    // pairing controller + runner publish wiring.
    await sock.ev.emit('connection.update', { qr: qrPayload });

    // A's subscriber received the instance.qr frame carrying the payload.
    const qrFramesA = framesA.filter((f) => f.event === 'instance.qr');
    expect(qrFramesA.length).toBeGreaterThan(0);
    expect(qrFramesA.some((f) => f.data.includes(qrPayload))).toBe(true);

    // B's subscriber received ZERO frames containing the qr payload -
    // in fact zero frames at all (B was never subscribed to A's channel).
    expect(framesB.length).toBe(0);
    expect(framesB.some((f) => f.data.includes(qrPayload))).toBe(false);

    // Enumerate the ENTIRE test Redis keyspace and assert no key name or
    // stored value contains the seeded qr payload string. `KEYS *` is used
    // here ONLY because this is a test against a small, isolated dev Redis -
    // production code must NEVER call KEYS/SCAN across the live keyspace
    // (unbounded O(N) blocking scan); see platform/redis.ts's own doc
    // comments on the sanctioned per-tenant key helpers instead.
    const allKeys: string[] = await redis.keys('*');
    for (const key of allKeys) {
      expect(key).not.toContain(qrPayload);
    }
    for (const key of allKeys) {
      const type = await redis.type(key);
      let value: string | null = null;
      if (type === 'string') {
        value = await redis.get(key);
      } else if (type === 'hash') {
        value = JSON.stringify(await redis.hgetall(key));
      } else if (type === 'list') {
        value = JSON.stringify(await redis.lrange(key, 0, -1));
      } else if (type === 'set') {
        value = JSON.stringify(await redis.smembers(key));
      } else if (type === 'zset') {
        value = JSON.stringify(await redis.zrange(key, '0', '-1'));
      }
      if (value !== null) {
        expect(value).not.toContain(qrPayload);
      }
    }
  });
});
