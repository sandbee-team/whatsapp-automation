import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl, sysKey } from '../../platform/redis.js';
import { createRealtimeHub } from './hub.js';
import { fakeSink } from './__tests__/hub-test-support.js';
import { createRedisRealtimePublisher, createRedisRealtimeSubscriber } from './redis-bridge.js';

/**
 * redis-bridge.integration.test.ts (P08 U6b PART 2) - real Redis Pub/Sub
 * proving the worker-side publisher reaches an in-process hub subscriber
 * through the API-side subscriber, an invalid frame is dropped without
 * throwing (counted, never logged with its payload), and a frame for an
 * unsubscribed tenant reaches nobody.
 */

const ENV = 'test';

describe('redis realtime bridge (real Redis)', () => {
  let publisherRedis: ReturnType<typeof createRedis>;
  let subscriberRedis: ReturnType<typeof createRedis>;

  afterEach(async () => {
    publisherRedis?.disconnect();
    subscriberRedis?.disconnect();
  });

  afterAll(() => {
    // Nothing pool-like to close beyond the per-test disconnects above.
  });

  it('an_instance_qr_event_published_reaches_an_in_process_hub_subscriber', async () => {
    publisherRedis = createRedis(resolveRedisUrl());
    subscriberRedis = createRedis(resolveRedisUrl());

    const hub = createRealtimeHub({ replayRingSize: 10 });
    const clientId = randomUUID();
    const instanceId = randomUUID();
    const channel = `client:${clientId}:instance:${instanceId}`;

    const { sink, written } = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink,
    });

    const warnCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    let dropped = 0;
    const subscriber = createRedisRealtimeSubscriber({
      redis: subscriberRedis,
      env: ENV,
      hub,
      logger: { warn: (msg, meta) => warnCalls.push({ msg, meta }) },
      metrics: { incrementDropped: () => (dropped += 1) },
    });
    await subscriber.start();

    const publisher = createRedisRealtimePublisher({ redis: publisherRedis, env: ENV });
    publisher.publish({
      type: 'instance.qr',
      clientId,
      instanceId,
      payload: 'fake-qr-string',
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
      attemptsLeft: 4,
    });

    await vi_waitFor(() => written.length > 0);

    expect(written).toHaveLength(1);
    const frame = written[0]!;
    expect(frame.event).toBe('instance.qr');
    const data = JSON.parse(frame.data) as { payload: string; instanceId: string };
    expect(data.payload).toBe('fake-qr-string');
    expect(data.instanceId).toBe(instanceId);
    expect(dropped).toBe(0);
    expect(warnCalls).toHaveLength(0);

    await subscriber.stop();
  });

  it('an_invalid_frame_is_dropped_without_throwing_and_increments_the_drop_counter', async () => {
    publisherRedis = createRedis(resolveRedisUrl());
    subscriberRedis = createRedis(resolveRedisUrl());

    const hub = createRealtimeHub({ replayRingSize: 10 });
    let dropped = 0;
    const warnCalls: string[] = [];
    const subscriber = createRedisRealtimeSubscriber({
      redis: subscriberRedis,
      env: ENV,
      hub,
      logger: { warn: (msg) => warnCalls.push(msg) },
      metrics: { incrementDropped: () => (dropped += 1) },
    });
    await subscriber.start();

    const channel = sysKey(ENV, 'rt', 'bridge');

    // Garbage JSON.
    publisherRedis.publish(channel, 'not-json-{{{');
    await vi_waitFor(() => dropped >= 1);

    // Schema-violating object (valid JSON, unknown/missing fields).
    publisherRedis.publish(channel, JSON.stringify({ type: 'not.a.real.event' }));
    await vi_waitFor(() => dropped >= 2);

    expect(dropped).toBe(2);
    expect(warnCalls).toHaveLength(2);
    // Never logs the raw payload.
    for (const msg of warnCalls) {
      expect(msg).not.toContain('not-json');
      expect(msg).not.toContain('not.a.real.event');
    }

    await subscriber.stop();
  });

  it('a_frame_for_an_unsubscribed_tenant_reaches_nobody', async () => {
    publisherRedis = createRedis(resolveRedisUrl());
    subscriberRedis = createRedis(resolveRedisUrl());

    const hub = createRealtimeHub({ replayRingSize: 10 });
    const subscribedClientId = randomUUID();
    const subscribedChannel = `client:${subscribedClientId}`;
    const { sink, written } = fakeSink();
    hub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId: subscribedClientId,
      epoch: 0,
      channels: [subscribedChannel],
      sink,
    });

    let dropped = 0;
    const subscriber = createRedisRealtimeSubscriber({
      redis: subscriberRedis,
      env: ENV,
      hub,
      logger: { warn: () => undefined },
      metrics: { incrementDropped: () => (dropped += 1) },
    });
    await subscriber.start();

    const publisher = createRedisRealtimePublisher({ redis: publisherRedis, env: ENV });
    const otherClientId = randomUUID();
    publisher.publish({
      type: 'instance.health_changed',
      clientId: otherClientId,
      instanceId: randomUUID(),
      healthState: 'connected',
      pauseReason: null,
      needsUserAction: false,
    });

    // Give the subscriber a moment to process (it validates fine, routes to
    // a channel nobody is on) - assert nothing arrives and nothing drops.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(written).toHaveLength(0);
    expect(dropped).toBe(0);

    await subscriber.stop();
  });
});

/** Polls `predicate` until true or a bounded timeout - no arbitrary sleep chains. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('vi_waitFor: timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
