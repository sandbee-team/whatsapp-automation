import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { sysKey } from '../../platform/redis.js';
import {
  discoveryWakeChannel,
  publishDiscoveryWake,
  createDiscoveryWakeSubscriber,
} from './discovery-wake.js';

/**
 * discovery-wake.test.ts (2026-09-17, "QR takes 3-12s to appear" fix) - the
 * fleet-wide discovery wake's pure/unit-testable surface, mirroring
 * `engine/queue/wake.test.ts`'s own idiom exactly: channel-shape derivation,
 * the publish call shape (including swallowing a publish failure, never
 * throwing into the `/link` request path), and the subscriber's
 * channel-filtering + start/stop lifecycle.
 */

describe('discoveryWakeChannel', () => {
  it('is_fleet_wide_with_no_client_or_instance_segment', () => {
    // Unlike wake.ts's per-instance channel, this one carries no
    // clientId/instanceId - built via sysKey, never a raw template literal
    // (the wp/key-construction guard rejects that outside platform/redis/**).
    expect(discoveryWakeChannel('test')).toBe(sysKey('test', 'discovery', 'wake'));
    expect(discoveryWakeChannel('test')).toBe('wp:test:discovery:wake');
  });
});

describe('publishDiscoveryWake', () => {
  it('publishes_exactly_one_wake_on_the_fleet_wide_channel', async () => {
    const published: { channel: string; message: string }[] = [];
    const redis = {
      publish: vi.fn(async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      }),
    };

    await publishDiscoveryWake(redis, 'test');

    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe(discoveryWakeChannel('test'));
  });

  it('a_publish_failure_is_swallowed_never_thrown', async () => {
    // A `/link` request must never fail because Redis happened to be
    // momentarily unreachable for this best-effort latency hint - the
    // mandatory scan-interval poll is what makes a dropped wake survivable.
    const redis = { publish: vi.fn().mockRejectedValue(new Error('redis down')) };

    await expect(publishDiscoveryWake(redis, 'test')).resolves.toBeUndefined();
  });
});

describe('createDiscoveryWakeSubscriber', () => {
  function fakeRedis(): {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    emit: (channel: string) => void;
  } {
    let handler: ((channel: string) => void) | undefined;
    return {
      on: vi.fn((_event: string, cb: (channel: string) => void) => {
        handler = cb;
      }),
      off: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      emit: (channel: string) => handler?.(channel),
    };
  }

  it('start_subscribes_the_fleet_wide_channel_and_onWake_fires_on_a_matching_message', async () => {
    const redis = fakeRedis();
    const onWake = vi.fn();
    const subscriber = createDiscoveryWakeSubscriber({
      redis: redis as never,
      env: 'test',
      onWake,
    });

    await subscriber.start();

    expect(redis.subscribe).toHaveBeenCalledWith(discoveryWakeChannel('test'));
    redis.emit(discoveryWakeChannel('test'));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('a_message_on_a_different_channel_never_triggers_onWake', async () => {
    // Defence in depth: this subscriber's dedicated connection only ever
    // subscribes to ITS OWN channel, but the handler itself also filters by
    // channel name (same shape wake.ts's own createWakeSubscriber uses) -
    // never treats an unrelated pub/sub message on this connection as a
    // discovery wake.
    const redis = fakeRedis();
    const onWake = vi.fn();
    const subscriber = createDiscoveryWakeSubscriber({ redis: redis as never, env: 'test', onWake });
    await subscriber.start();

    redis.emit('wp:test:some:other:channel');
    expect(onWake).not.toHaveBeenCalled();
  });

  it('stop_unsubscribes_but_never_calls_disconnect_the_caller_owns_that', async () => {
    const redis = fakeRedis();
    const subscriber = createDiscoveryWakeSubscriber({
      redis: redis as never,
      env: 'test',
      onWake: vi.fn(),
    });
    await subscriber.start();

    await subscriber.stop();

    expect(redis.unsubscribe).toHaveBeenCalledWith(discoveryWakeChannel('test'));
    expect(redis.off).toHaveBeenCalledTimes(1);
  });

  it('increments_the_optional_metrics_counter_once_per_received_wake', async () => {
    const redis = fakeRedis();
    const incrementDiscoveryWakeReceived = vi.fn();
    const subscriber = createDiscoveryWakeSubscriber({
      redis: redis as never,
      env: 'test',
      onWake: vi.fn(),
      metrics: { incrementDiscoveryWakeReceived },
    });
    await subscriber.start();

    redis.emit(discoveryWakeChannel('test'));
    redis.emit(discoveryWakeChannel('test'));

    expect(incrementDiscoveryWakeReceived).toHaveBeenCalledTimes(2);
  });
});
