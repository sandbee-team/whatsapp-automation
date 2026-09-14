import { describe, expect, it, vi } from 'vitest';
import { sysKey } from '../../platform/redis.js';
import { createRealtimeHub } from './hub.js';
import {
  createRedisRealtimePublisher,
  createRedisRealtimeSubscriber,
  type RedisRealtimeSubscriberLogger,
} from './redis-bridge.js';

/**
 * redis-bridge.batch.test.ts (P15 U4, step 5) - the MINIMAL batch-frame
 * acceptance extension to the cross-process bridge: `publishBatch` validates
 * a `BatchFrame` (`@wp/contracts`'s `batchFrameSchema`) then publishes its
 * validated JSON, tagged `kind: 'batch'` plus routing metadata, onto the
 * SAME one bridge channel `publish` already uses - the relay (P15 U4) never
 * opens a second Redis channel. The subscriber re-validates on receipt
 * (defence in depth, same discipline as the single-event path) and forwards
 * every event inside the frame to the hub via one `hub.publish` call per
 * event - batching is a wire-transport optimisation for the relay->bridge
 * leg; how many SSE wire frames the browser actually receives is governed
 * entirely by the relay's own tick rate (coalescer.test.ts / relay-loop.ts),
 * not by this module.
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

describe('redis-bridge publishBatch', () => {
  it('validates_and_publishes_a_batch_frame_onto_the_one_bridge_channel', () => {
    const publishedFrames: { channel: string; message: string }[] = [];
    const fakeRedisPublish = {
      publish: vi.fn((channel: string, message: string) => {
        publishedFrames.push({ channel, message });
        return Promise.resolve(1);
      }),
    };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });
    const clientId = '11111111-1111-4111-8111-111111111111';
    const instanceId = '22222222-2222-4222-8222-222222222222';

    publisher.publishBatch(clientId, instanceId, {
      v: 1,
      truncated: false,
      events: [
        {
          type: 'instance.health_changed',
          instanceId,
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
        },
      ],
    });

    expect(publishedFrames).toHaveLength(1);
    expect(publishedFrames[0]?.channel).toBe(CHANNEL);
    const wire = JSON.parse(publishedFrames[0]?.message ?? '{}') as Record<string, unknown>;
    expect(wire.kind).toBe('batch');
    expect(wire.clientId).toBe(clientId);
    expect(wire.instanceId).toBe(instanceId);
    expect(wire.frame).toEqual({
      v: 1,
      truncated: false,
      events: [
        {
          type: 'instance.health_changed',
          instanceId,
          healthState: 'connected',
          pauseReason: null,
          needsUserAction: false,
        },
      ],
    });
  });

  it('publishBatch_rejects_an_invalid_frame_before_it_ever_reaches_redis', () => {
    const fakeRedisPublish = { publish: vi.fn() };
    const publisher = createRedisRealtimePublisher({ redis: fakeRedisPublish, env: ENV });

    expect(() =>
      publisher.publishBatch(
        '11111111-1111-4111-8111-111111111111',
        null,
        // Missing `truncated` - fails batchFrameSchema's `.strict()`.
        { v: 1, events: [] } as never,
      ),
    ).toThrow();
    expect(fakeRedisPublish.publish).not.toHaveBeenCalled();
  });

  it('subscriber_forwards_every_event_inside_a_received_batch_frame_to_the_hub', async () => {
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

    const clientId = '11111111-1111-4111-8111-111111111111';
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const wireMessage = JSON.stringify({
      kind: 'batch',
      clientId,
      instanceId,
      frame: {
        v: 1,
        truncated: false,
        events: [
          {
            type: 'instance.health_changed',
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          {
            type: 'campaign.progress',
            campaignId: '33333333-3333-4333-8333-333333333333',
            sent: 1,
            queued: 0,
            failed: 0,
          },
        ],
      },
    });

    expect(() => captured!(CHANNEL, wireMessage)).not.toThrow();
    expect(hubPublish).toHaveBeenCalledTimes(2);
    expect(hubPublish.mock.calls[0]?.[0]).toMatchObject({
      clientId,
      type: 'instance.health_changed',
    });
    expect(hubPublish.mock.calls[1]?.[0]).toMatchObject({ clientId, type: 'campaign.progress' });
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('subscriber_drops_a_batch_frame_that_fails_schema_validation', async () => {
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

    const badMessage = JSON.stringify({
      kind: 'batch',
      clientId: '11111111-1111-4111-8111-111111111111',
      frame: { v: 1, events: [], truncated: 'not-a-boolean' },
    });

    expect(() => captured!(CHANNEL, badMessage)).not.toThrow();
    expect(hubPublish).not.toHaveBeenCalled();
    expect(logger.warnCalls).toHaveLength(1);
  });

  it('a_batch_with_a_campaign_progress_event_and_a_group_instanceId_delivers_every_event_with_zero_throws', async () => {
    // BUG FIX (P15 C1 FIX F6 / MAJ-4): `onBatchMessage` used to spread the
    // group `instanceId` into EVERY event unconditionally - a strict schema
    // without that field (campaign.progress, job.needs_user_action,
    // webhook.endpoint_disabled) fails `realtimeEventSchema.parse`'s
    // `.strict()` check inside the REAL `hub.publish` (see hub.ts), throwing
    // synchronously from inside the `for` loop and killing every OTHER event
    // in the same batch too. The sibling test above
    // (`subscriber_forwards_every_event_inside_a_received_batch_frame_to_the_hub`)
    // never caught this because it injects a bare `vi.fn()` in place of
    // `hub.publish`, which never throws - this test uses the REAL hub.
    const logger = makeLogger();
    const hub = createRealtimeHub({ replayRingSize: 8 });
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
      hub,
      logger,
    });
    await subscriber.start();
    if (!captured) throw new Error('missing captured handler');

    const clientId = '11111111-1111-4111-8111-111111111111';
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const campaignId = '33333333-3333-4333-8333-333333333333';
    const wireMessage = JSON.stringify({
      kind: 'batch',
      clientId,
      // The GROUP carries an instanceId (a real relay-loop group is keyed by
      // (client_id, instance_id)) even though ONE of its coalesced events
      // (campaign.progress) declares no such field on its own schema.
      instanceId,
      frame: {
        v: 1,
        truncated: false,
        events: [
          { type: 'campaign.progress', campaignId, sent: 1, queued: 0, failed: 0 },
          {
            type: 'instance.health_changed',
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
        ],
      },
    });

    // A connection subscribed to BOTH the client-wide channel (where
    // campaign.progress - no instanceId field - lands) and the
    // instance-scoped channel (where instance.health_changed lands),
    // capturing every frame it actually receives via its sink.
    const receivedEvents: string[] = [];
    hub.connect({
      connectionId: 'conn-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`, `client:${clientId}:instance:${instanceId}`],
      sink: {
        write: (frame) => {
          receivedEvents.push(frame.event);
        },
        comment: () => undefined,
        close: () => undefined,
        onClose: () => undefined,
      },
    });

    expect(() => captured!(CHANNEL, wireMessage)).not.toThrow();
    // Zero drops AND both events actually delivered to the connection - the
    // schema mismatch on campaign.progress's missing instanceId field never
    // throws away the OTHER event in the same batch.
    expect(logger.warnCalls).toHaveLength(0);
    expect(receivedEvents.sort()).toEqual(['campaign.progress', 'instance.health_changed']);
  });
});
