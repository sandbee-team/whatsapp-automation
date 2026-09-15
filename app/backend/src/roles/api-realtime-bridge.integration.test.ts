import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { logger } from '@wp/server-kit';
import { createRedis, resolveRedisUrl } from '../platform/redis.js';
import { loadConfig } from '../platform/config.js';
import { createRealtimeHub } from '../modules/realtime/hub.js';
import { fakeSink } from '../modules/realtime/__tests__/hub-test-support.js';
import {
  createRedisRealtimePublisher,
  createRedisRealtimeSubscriber,
} from '../modules/realtime/redis-bridge.js';

/**
 * roles/api-realtime-bridge.integration.test.ts (FIX, discovered 2026-09-15
 * on the first live deployment - QR codes never reached the browser) - proves
 * the SPECIFIC wiring added to `roles/api.ts`'s `main()`, not just the bridge
 * primitives `modules/realtime/redis-bridge.integration.test.ts` already
 * covers.
 *
 * WHY A SEPARATE FILE, AND WHAT IT DOES/DOES NOT PROVE: `roles/api.ts`'s
 * `main()` is a top-level `async function` with no exported seam - it opens a
 * real Postgres pool, calls `app.listen`, and registers `process.on('SIGTERM'
 * | 'SIGINT', ...)` as a side effect of being invoked at all (see the bottom
 * of that file: `main().catch(...)`). Every existing `roles/*.integration.test.ts`
 * file in this tree (relay.integration.test.ts, relay-cleanup-and-qr...,
 * etc.) follows the SAME discipline documented in relay.integration.test.ts's
 * own header: "NOT a role entrypoint... this file calls `drainOnce` directly,
 * never `assertDbPreconditionsOrExit`" - i.e. this repo never invokes a
 * role's `main()` from a test; it reconstructs the composition the role
 * builds and proves THAT. This file does the same for the one new piece
 * `api.ts` now builds: `createRedis(config.REDIS_URL)` handed to
 * `createRedisRealtimeSubscriber({ redis, env: config.NODE_ENV, hub, logger })`,
 * started before `listen` and feeding the SAME `realtimeHub` instance SSE
 * routes read from.
 *
 * This DOES prove: with `config.NODE_ENV` (via the real `loadConfig`, exactly
 * as `api.ts` calls it) driving the channel derivation on BOTH sides, and a
 * real Redis Pub/Sub round trip, an `instance.qr` event published exactly the
 * way `session-worker.ts`'s publisher publishes it reaches a hub built and
 * wired exactly the way `api.ts` wires `realtimeHub` - i.e. the composition
 * `api.ts` now contains is the same composition that closes this bug, and if
 * the subscriber wiring in `api.ts` were reverted (or its `env`/channel
 * derivation drifted from the publisher's), the equivalent assertion in
 * PRODUCTION would fail exactly as it did before this fix.
 *
 * NOT a role entrypoint (same note as relay.integration.test.ts's own header,
 * re: `scripts/check-role-boot.ts`'s glob over `app/backend/src/roles/**\/*.ts`
 * including sibling test files): no `assertDbPreconditionsOrExit` call here -
 * that gate belongs to `roles/api.ts`'s own `main()`, exercised structurally
 * (by reading), not per-test.
 *
 * This does NOT prove: that `api.ts`'s `main()` itself calls
 * `subscriber.start()` at the right point in boot order, or that its
 * shutdown path calls `subscriber.stop()`/disconnects the dedicated
 * connection cleanly - `main()` has no test seam for that (see above), so
 * that ordering was verified by reading, not by an executed assertion. It
 * also does not prove SSE-route-level delivery (the HTTP layer) - that is
 * `modules/realtime/routes.ts`'s own tested surface, unchanged by this fix.
 */

describe('api role - redis realtime bridge composition (real Redis)', () => {
  let publisherRedis: ReturnType<typeof createRedis>;
  let subscriberRedis: ReturnType<typeof createRedis>;

  afterEach(() => {
    publisherRedis?.disconnect();
    subscriberRedis?.disconnect();
  });

  it('an_instance_qr_event_published_by_the_worker_side_publisher_reaches_the_api_composed_hub', async () => {
    // Same `loadConfig` call `api.ts`'s `main()` makes - `config.NODE_ENV`
    // is what BOTH the publisher (session-worker.ts) and this subscriber
    // (api.ts) derive their shared bridge channel from (`sysKey(env, 'rt',
    // 'bridge')` inside redis-bridge.ts) - never hardcode a channel string
    // here, or a channel-derivation drift between the two roles would go
    // undetected.
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' });

    publisherRedis = createRedis(resolveRedisUrl());
    subscriberRedis = createRedis(resolveRedisUrl());

    // The exact hub `api.ts` builds via `createRealtimeHub` and wires as
    // `realtimeCtx.hub` for every SSE route.
    const realtimeHub = createRealtimeHub({ replayRingSize: 10 });

    const clientId = randomUUID();
    const instanceId = randomUUID();
    const channel = `client:${clientId}:instance:${instanceId}`;
    const { sink, written } = fakeSink();
    realtimeHub.connect({
      connectionId: randomUUID(),
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [channel],
      sink,
    });

    // The EXACT construction `api.ts` now performs: its own dedicated
    // connection (never the shared command connection), `config.NODE_ENV`,
    // the real hub, and the SAME `(msg, meta?)` -> pino `(fields, msg)`
    // adapter `api.ts` wraps the real `@wp/server-kit` logger in (that
    // module's own `WpLogger.warn` is pino-shaped `(fields, msg)` - the
    // OPPOSITE argument order `RedisRealtimeSubscriberLogger` expects, so
    // passing `logger` straight through would silently hand it a string
    // where it expects a fields object).
    const subscriber = createRedisRealtimeSubscriber({
      redis: subscriberRedis,
      env: config.NODE_ENV,
      hub: realtimeHub,
      logger: {
        warn: (msg, meta) => {
          logger.warn({}, meta ? `${msg} ${JSON.stringify(meta)}` : msg);
        },
      },
    });
    await subscriber.start();

    try {
      // The EXACT construction `session-worker.ts` performs
      // (session-worker.ts:120-123) and the exact call shape
      // `pairing.ts:100-107` makes on an `instance.qr` event.
      const publisher = createRedisRealtimePublisher({
        redis: publisherRedis,
        env: config.NODE_ENV,
      });
      publisher.publish({
        type: 'instance.qr',
        clientId,
        instanceId,
        payload: 'fake-qr-string-never-a-real-credential',
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
        attemptsLeft: 4,
      });

      await waitFor(() => written.length > 0);

      expect(written).toHaveLength(1);
      const frame = written[0]!;
      expect(frame.event).toBe('instance.qr');
      const data = JSON.parse(frame.data) as { payload: string; instanceId: string };
      expect(data.payload).toBe('fake-qr-string-never-a-real-credential');
      expect(data.instanceId).toBe(instanceId);
    } finally {
      await subscriber.stop();
    }
  });
});

/** Polls `predicate` until true or a bounded timeout - no arbitrary sleep chains (mirrors redis-bridge.integration.test.ts's own helper). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
