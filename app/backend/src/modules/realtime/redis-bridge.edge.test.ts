import { describe, expect, it, vi } from 'vitest';
import { sysKey } from '../../platform/redis.js';
import {
  createRedisRealtimePublisher,
  createRedisRealtimeSubscriber,
  type RedisRealtimeSubscriberLogger,
} from './redis-bridge.js';

/**
 * redis-bridge.edge.test.ts - E3 edge-case pass (P08 session-qr-linking).
 * Fake `redis`/`hub`/`logger` ports only - no real Redis connection (unit
 * level, deterministic). Covers: a HUGE (1MB) QR payload frame (pinned:
 * delivered, no crash, no truncation - `payload` is `z.string()` with no
 * length cap per the module's own schema doc), the subscriber surviving a
 * malformed UTF-8/binary publish (dropped, counted, never thrown), and the
 * publisher rejecting an event missing `instanceId` (thrown at publish time,
 * before it ever reaches Redis - `instanceQrEventSchema` is `.strict()` and
 * requires `instanceId: z.uuid()`).
 */

const ENV = 'test';
const CHANNEL = sysKey(ENV, 'rt', 'bridge');

function makeLogger(): RedisRealtimeSubscriberLogger & { warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  return {
    warnCalls,
    warn: (msg: string, meta?: Record<string, unknown>) => {
      warnCalls.push([msg, meta]);
    },
  };
}

interface BuiltSubscriber {
  onMessage: (message: string) => void;
  hubPublish: ReturnType<typeof vi.fn>;
  logger: RedisRealtimeSubscriberLogger & { warnCalls: unknown[][] };
  droppedCount: () => number;
}

/**
 * Builds a real `createRedisRealtimeSubscriber` against a fake `redis` port
 * whose `.on('message', cb)` call is captured, then calls `.start()` so the
 * bridge's own `onMessage` wiring runs exactly as production does - the
 * returned `onMessage` calls that SAME captured handler with `CHANNEL`
 * (the bridge's one real channel), simulating a message arriving on it.
 */
async function buildSubscriber(): Promise<BuiltSubscriber> {
  const hubPublish = vi.fn();
  const logger = makeLogger();
  let captured: ((channel: string, message: string) => void) | undefined;
  let dropped = 0;

  const fakeRedis = {
    on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
      if (event === 'message') captured = cb;
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    off: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };

  const subscriber = createRedisRealtimeSubscriber({
    redis: fakeRedis as never,
    env: ENV,
    hub: { publish: hubPublish },
    logger,
    metrics: { incrementDropped: () => (dropped += 1) },
  });

  await subscriber.start();
  if (!captured) throw new Error('subscriber.start() never called redis.on("message", ...)');
  const handler = captured;

  return {
    onMessage: (message: string) => handler(CHANNEL, message),
    hubPublish,
    logger,
    droppedCount: () => dropped,
  };
}

describe('redis-bridge edge: huge payload', () => {
  it('a_1mb_qr_payload_is_published_and_delivered_without_crashing_or_truncating', async () => {
    const publishedFrames: { channel: string; message: string }[] = [];
    const fakeRedisPublish = {
      publish: vi.fn((channel: string, message: string) => {
        publishedFrames.push({ channel, message });
        return Promise.resolve(1);
      }),
    };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });

    const hugePayload = 'Q'.repeat(1024 * 1024); // 1 MiB
    const instanceId = '11111111-1111-4111-8111-111111111111';

    expect(() =>
      publisher.publish({
        type: 'instance.qr',
        clientId: 'client-huge',
        instanceId,
        payload: hugePayload,
        expiresAt: new Date(0).toISOString(),
        attemptsLeft: 3,
      }),
    ).not.toThrow();

    expect(publishedFrames).toHaveLength(1);
    const wireMessage = publishedFrames[0]?.message ?? '';
    expect(wireMessage.length).toBeGreaterThan(1024 * 1024);

    // Subscriber side: the huge frame is delivered through to the hub intact
    // - no crash, no truncation of the payload string.
    const { onMessage, hubPublish, logger } = await buildSubscriber();
    expect(() => onMessage(wireMessage)).not.toThrow();

    expect(hubPublish).toHaveBeenCalledTimes(1);
    const delivered = hubPublish.mock.calls[0]?.[0] as { payload?: string };
    expect(delivered.payload).toBe(hugePayload);
    expect(logger.warnCalls).toHaveLength(0);
  });
});

describe('redis-bridge edge: subscriber survives a malformed publish', () => {
  it('non_utf8_binary_garbage_is_dropped_counted_and_never_thrown', async () => {
    const { onMessage, hubPublish, logger, droppedCount } = await buildSubscriber();

    // Binary garbage that is not valid JSON at all (raw bytes / lone
    // surrogate as a JS string, the closest a `message: string` ioredis
    // callback can carry to "invalid UTF-8").
    const garbage = '\uD800\uD800 ￿{{{not json';

    expect(() => onMessage(garbage)).not.toThrow();
    expect(hubPublish).not.toHaveBeenCalled();
    expect(droppedCount()).toBe(1);
    expect(logger.warnCalls).toHaveLength(1);
    // Never logs the raw frame body itself (security: may contain a QR
    // fragment) - only the fixed, allow-listed message string.
    expect(logger.warnCalls[0]?.[0]).toBe(
      'redis-bridge subscriber: dropped a frame that was not valid JSON',
    );
    expect(JSON.stringify(logger.warnCalls[0])).not.toContain('not json');
  });

  it('a_well_formed_json_value_that_is_not_an_object_is_dropped_not_thrown', async () => {
    const { onMessage, hubPublish, droppedCount } = await buildSubscriber();

    expect(() => onMessage(JSON.stringify(42))).not.toThrow();
    expect(hubPublish).not.toHaveBeenCalled();
    expect(droppedCount()).toBe(1);
  });

  it('messages_on_a_different_channel_are_ignored_entirely', async () => {
    const hubPublish = vi.fn();
    const logger = makeLogger();
    let captured: ((channel: string, message: string) => void) | undefined;
    const fakeRedis = {
      on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
        if (event === 'message') captured = cb;
      }),
      subscribe: vi.fn().mockResolvedValue(undefined),
      off: vi.fn(),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };
    const subscriber = createRedisRealtimeSubscriber({
      redis: fakeRedis as never,
      env: ENV,
      hub: { publish: hubPublish },
      logger,
    });
    await subscriber.start();
    if (!captured) throw new Error('missing captured handler');

    expect(() => captured!('some-other-channel', 'irrelevant')).not.toThrow();
    expect(hubPublish).not.toHaveBeenCalled();
    expect(logger.warnCalls).toHaveLength(0);
  });
});

describe('redis-bridge edge: publisher publish rejection is never invisible', () => {
  it('a_rejecting_redis_publish_increments_the_dropped_publish_counter_and_never_throws', async () => {
    // FIX BATCH B / B4: redis.publish()'s returned promise used to be
    // discarded - a connection-down error on the QR path vanished silently.
    const rejectingRedisPublish = {
      publish: vi.fn(() => Promise.reject(new Error('ECONNREFUSED: redis down'))),
    };
    let dropped = 0;
    let droppedResolve!: () => void;
    const droppedSignal = new Promise<void>((resolve) => {
      droppedResolve = resolve;
    });
    const publisher = createRedisRealtimePublisher({
      redis: rejectingRedisPublish,
      env: ENV,
      metrics: {
        incrementDroppedPublish: () => {
          dropped += 1;
          droppedResolve();
        },
      },
    });

    expect(() =>
      publisher.publish({
        type: 'instance.qr',
        clientId: 'client-publish-fails',
        instanceId: '33333333-3333-4333-8333-333333333333',
        payload: 'qr-string-must-never-be-logged',
        expiresAt: new Date(0).toISOString(),
        attemptsLeft: 2,
      }),
    ).not.toThrow();

    // Deterministic: waits on the counter's own signal (resolved from inside
    // the module's `.catch()` handler), never an arbitrary sleep.
    await droppedSignal;
    expect(dropped).toBe(1);
  });
});

describe('redis-bridge edge: publisher rejects an event missing instanceId', () => {
  it('an_instance_qr_event_with_no_instanceId_throws_at_publish_time_never_reaches_redis', () => {
    const fakeRedisPublish = { publish: vi.fn() };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });

    expect(() =>
      publisher.publish({
        type: 'instance.qr',
        clientId: 'client-no-instance-id',
        // instanceId deliberately omitted - instanceQrEventSchema requires
        // z.uuid() and the schema is .strict().
        payload: 'qr-string',
        expiresAt: new Date(0).toISOString(),
        attemptsLeft: 1,
      } as never),
    ).toThrow();

    expect(fakeRedisPublish.publish).not.toHaveBeenCalled();
  });

  it('a_frame_missing_the_clientId_routing_field_is_dropped_by_the_subscriber_not_thrown', async () => {
    const { onMessage, hubPublish, logger, droppedCount } = await buildSubscriber();

    const frameMissingClientId = JSON.stringify({
      type: 'instance.health_changed',
      instanceId: '22222222-2222-4222-8222-222222222222',
      healthState: 'connected',
      pauseReason: null,
      needsUserAction: false,
      // clientId intentionally omitted.
    });

    expect(() => onMessage(frameMissingClientId)).not.toThrow();
    expect(hubPublish).not.toHaveBeenCalled();
    expect(droppedCount()).toBe(1);
    expect(logger.warnCalls[0]?.[0]).toBe(
      'redis-bridge subscriber: dropped a frame with no clientId routing field',
    );
  });
});
