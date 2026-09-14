import { describe, expect, it, vi } from 'vitest';
import { sysKey } from '../../platform/redis.js';
import {
  createRedisRealtimePublisher,
  createRedisRealtimeSubscriber,
  type RedisRealtimeSubscriberLogger,
} from './redis-bridge.js';

/**
 * redis-bridge.c2.test.ts (P08 C2, targeted category 7) - publisher retry
 * duplication: the SAME validated event published TWICE (e.g. a
 * `redis.publish` caller retrying after an ambiguous ack, or a future outbox
 * relay redelivering) reaches the subscriber as TWO separate frames, and the
 * subscriber has NO dedupe of its own (no event-id tracking anywhere in this
 * module) - it forwards both to the hub as two separate `hub.publish` calls.
 *
 * DISPOSITION (per event type, reasoned explicitly since the task calls for
 * a stated reasoning either way):
 *   - `instance.qr`: ACCEPTABLE FOR P08. The panel's own QR rendering is
 *     idempotent by construction - re-rendering the SAME qr string/expiresAt
 *     a second time is a harmless re-paint, not a state corruption. The
 *     panel does not accumulate a list of QR events; it always displays only
 *     the LATEST one for an instance.
 *   - `instance.health_changed`: ACCEPTABLE FOR P08. This event type carries
 *     NO payload beyond `clientId`/`instanceId` (see `QrPublishEvent`'s own
 *     union in `engine/session/pairing.ts`) - it is purely a "go refetch this
 *     instance's status" signal (ADR 0010: SSE carries ids only, the client
 *     refetches over the authorized API). A duplicate signal just causes one
 *     extra harmless refetch of the SAME already-current state.
 *   - General rule stated once, not re-derived per type: this bridge is
 *     documented (redis-bridge.ts's own header comment) as "fire and forget"
 *     with P15's outbox relay as the durable replacement - deduping publisher
 *     retries is explicitly OUT OF SCOPE for this phase, not an oversight.
 *     A future event type with a NON-idempotent side effect on the SSE
 *     consumer side would need to either dedupe by its own id or move to the
 *     P15 outbox; no such event type exists in this phase's schema.
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

async function buildSubscriber(): Promise<{
  onMessage: (message: string) => void;
  hubPublish: ReturnType<typeof vi.fn>;
}> {
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
  if (!captured) throw new Error('subscriber.start() never called redis.on("message", ...)');
  const handler = captured;

  return { onMessage: (message: string) => handler(CHANNEL, message), hubPublish };
}

describe('redis-bridge c2: publisher retry duplication has no dedupe (documented, per event type)', () => {
  it('a_duplicated_instance_qr_publish_reaches_the_hub_twice_harmlessly', async () => {
    const publishedFrames: string[] = [];
    const fakeRedisPublish = {
      publish: vi.fn((_channel: string, message: string) => {
        publishedFrames.push(message);
        return Promise.resolve(1);
      }),
    };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });

    const event = {
      type: 'instance.qr' as const,
      clientId: 'client-dup',
      instanceId: '11111111-1111-4111-8111-111111111111',
      payload: 'qr-string',
      expiresAt: new Date(1000).toISOString(),
      attemptsLeft: 3,
    };

    // Publisher retry: the SAME event published twice (e.g. an ambiguous
    // ack on the first `redis.publish` call caused the caller to retry).
    publisher.publish(event);
    publisher.publish(event);
    expect(publishedFrames).toHaveLength(2);
    expect(publishedFrames[0]).toBe(publishedFrames[1]); // byte-identical frames.

    const { onMessage, hubPublish } = await buildSubscriber();
    onMessage(publishedFrames[0]!);
    onMessage(publishedFrames[1]!);

    // No dedupe: the subscriber forwards BOTH frames to the hub. Harmless
    // for instance.qr per this file's header reasoning (idempotent re-paint).
    expect(hubPublish).toHaveBeenCalledTimes(2);
    expect(hubPublish.mock.calls[0]?.[0]).toEqual(hubPublish.mock.calls[1]?.[0]);
  });

  it('a_duplicated_instance_health_changed_publish_reaches_the_hub_twice_harmlessly', async () => {
    const publishedFrames: string[] = [];
    const fakeRedisPublish = {
      publish: vi.fn((_channel: string, message: string) => {
        publishedFrames.push(message);
        return Promise.resolve(1);
      }),
    };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });

    const event = {
      type: 'instance.health_changed' as const,
      clientId: 'client-dup-health',
      instanceId: '22222222-2222-4222-8222-222222222222',
      healthState: 'connected' as const,
      pauseReason: null,
      needsUserAction: false,
    };

    publisher.publish(event as never);
    publisher.publish(event as never);
    expect(publishedFrames).toHaveLength(2);

    const { onMessage, hubPublish } = await buildSubscriber();
    onMessage(publishedFrames[0]!);
    onMessage(publishedFrames[1]!);

    // No dedupe here either - two identical "go refetch" signals, each
    // producing one extra harmless refetch of already-current state on the
    // SSE consumer side (never a correctness issue since the payload itself
    // carries no state, only ids - ADR 0010).
    expect(hubPublish).toHaveBeenCalledTimes(2);
    expect(hubPublish.mock.calls[0]?.[0]).toEqual(hubPublish.mock.calls[1]?.[0]);
  });
});
