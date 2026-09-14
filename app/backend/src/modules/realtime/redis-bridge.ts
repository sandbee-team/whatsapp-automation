import type { Redis } from 'ioredis';
import {
  realtimeEventSchema,
  batchFrameSchema,
  type RealtimeEvent,
  type BatchFrame,
} from '@wp/contracts';
import { REALTIME_PAYLOAD_KEYS, type RealtimePayloadEventType } from '@wp/domain';
import { sysKey } from '../../platform/redis.js';
import type { RealtimeHub } from './hub.js';

/**
 * modules/realtime/redis-bridge.ts (P08 U6b PART 2) - the minimal
 * cross-process real-time leg. `modules/realtime/hub.ts`'s `RealtimeHub` is
 * an IN-PROCESS-ONLY fan-out (ADR 0010: "correctness never depends on
 * NOTIFY" - no Postgres LISTEN, no outbox here either). The `api` role's SSE
 * connections live in the API process; `session-worker` runs in a SEPARATE
 * process and is the one that actually observes `instance.qr`/
 * `instance.health_changed` events as the Baileys socket emits them. This
 * module is the narrow bridge between the two: the worker-side publisher
 * writes one validated JSON frame onto a single Redis Pub/Sub channel, the
 * API-side subscriber reads it back and re-publishes into the REAL in-process
 * hub so existing SSE connections see it exactly as if `hub.publish` had been
 * called directly in-process.
 *
 * P15's outbox relay REPLACES this leg (an outbox table + a durable relay,
 * so a publish that lands while no subscriber is connected is never lost).
 * THIS bridge is Redis Pub/Sub only - "fire and forget": a message published
 * while the API process's subscriber is down (or mid-restart) is simply
 * never delivered. That is an accepted, documented gap for this phase (the
 * SSE stream itself is already best-effort/replay-ring-bounded, never a
 * durable guarantee) - never use this module as a substitute for a durable
 * queue/outbox.
 *
 * CHANNEL SHAPE DECISION: ONE bridge channel per env
 * (`sysKey(env, 'rt', 'bridge')`), carrying the FULLY validated event
 * (including `clientId`/`instanceId`) as its JSON payload - NOT one channel
 * per tenant. Rationale: the payload is already schema-validated before it
 * is ever written to Redis (`realtimeEventSchema.parse` on the publish side,
 * `.safeParse` again on the subscribe side - defence in depth, never trust
 * the wire blindly even though only this process's own publisher writes to
 * it), and the ONLY consumer of this channel is the API-side subscriber
 * (never a browser, never any other untrusted reader) - so there is no
 * tenant-isolation gap from fanning every tenant's events through one Redis
 * channel: the SAME code path today already re-validates and routes strictly
 * by the event's own `clientId`/`instanceId` fields once it reaches
 * `hub.publish` (that call re-derives the SSE channel name itself, exactly
 * as an in-process `hub.publish` caller would). A per-tenant channel would
 * add N subscriptions with no isolation benefit at this scale (single
 * subscriber process, single hub) - YAGNI beyond the structural target
 * (`.claude/skills/wp-architecture/SKILL.md` §11).
 *
 * THE QR STRING NEVER TOUCHES A LOG LINE on either side: the publisher only
 * ever logs (nothing - there is no log call on the publish path at all,
 * deliberately) and the subscriber's warn-on-drop path logs allow-listed
 * metadata ONLY (never the raw frame body - see `subscriber`'s drop branch
 * below). `payload` (the QR string, `instanceQrEventSchema`'s own field) is
 * schema-shaped as `z.string()` with no further validation - see
 * `packages/contracts/src/app/realtime.ts`'s own doc comment on that field:
 * "a BEARER CREDENTIAL... must never be logged, metriced, or written to
 * audit metadata".
 */

export interface RedisRealtimePublisher {
  /** Validates `event` via `realtimeEventSchema`, then `redis.publish`es the validated JSON onto the one bridge channel. Throws on a schema violation - never publishes an invalid frame. A `redis.publish` REJECTION (e.g. connection down) is caught internally and counted, never thrown/never awaited by the caller (see `CreateRedisRealtimePublisherOptions.metrics`'s doc comment). */
  publish(event: RealtimeEvent & { clientId: string; instanceId?: string }): void;
  /**
   * P15 U4 (step 5) - the relay's own leg: validates `frame` via
   * `batchFrameSchema` (`@wp/contracts`), then `redis.publish`es it, tagged
   * `kind: 'batch'` plus `clientId`/`instanceId` routing metadata, onto the
   * SAME one bridge channel `publish` uses - no second channel. Throws on a
   * schema violation, same fail-fast-before-any-I/O discipline as `publish`.
   * A `redis.publish` rejection is caught/counted the same way, never thrown.
   */
  publishBatch(clientId: string, instanceId: string | null, frame: BatchFrame): void;
}

export interface RedisRealtimePublisherMetricsPort {
  incrementDroppedPublish: () => void;
}

const NOOP_PUBLISHER_METRICS: RedisRealtimePublisherMetricsPort = {
  incrementDroppedPublish: () => undefined,
};

export interface CreateRedisRealtimePublisherOptions {
  redis: Pick<Redis, 'publish'>;
  env: string;
  /**
   * FIX BATCH B / B4: `redis.publish`'s returned promise used to be
   * discarded entirely - a connection-down error on (for example) the
   * `instance.qr` path vanished with no signal anywhere. `metrics` (defaults
   * to a no-op) is incremented on a rejection via `.catch()`; the frame body
   * is NEVER included in the counter or any log line (ids/enums-only
   * observability, same rule as the subscriber side of this module).
   */
  metrics?: RedisRealtimePublisherMetricsPort;
}

/** Builds the worker-side publisher half of the bridge. */
export function createRedisRealtimePublisher(
  options: CreateRedisRealtimePublisherOptions,
): RedisRealtimePublisher {
  const { redis, env } = options;
  const metrics = options.metrics ?? NOOP_PUBLISHER_METRICS;
  const channel = sysKey(env, 'rt', 'bridge');

  return {
    publish(event) {
      // Validate the EVENT payload itself (type + its own declared fields)
      // via the same schema `hub.ts`'s own `publish` uses - `clientId` is
      // routing metadata carried alongside, not part of the discriminated
      // union's own schema (mirrors hub.ts's own `eventOnly` split).
      // `instanceId` stays IN the validated payload when the event's own
      // schema declares it (e.g. instance.qr, instance.health_changed) -
      // only `campaign.progress`-shaped events have no such field.
      const eventOnly: Record<string, unknown> = { ...event };
      delete eventOnly.clientId;
      const parsed = realtimeEventSchema.parse(eventOnly) as Record<string, unknown>;
      const wire = { ...parsed, clientId: event.clientId };
      Promise.resolve(redis.publish(channel, JSON.stringify(wire))).catch(() => {
        // Never log the frame body (may carry the QR bearer credential) -
        // count only, ids/enums never included in the counter itself.
        metrics.incrementDroppedPublish();
      });
    },

    publishBatch(clientId, instanceId, frame) {
      const validated = batchFrameSchema.parse(frame);
      const wire = { kind: 'batch' as const, clientId, instanceId, frame: validated };
      Promise.resolve(redis.publish(channel, JSON.stringify(wire))).catch(() => {
        metrics.incrementDroppedPublish();
      });
    },
  };
}

export interface RedisRealtimeSubscriberLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface RedisRealtimeSubscriberMetricsPort {
  incrementDropped: () => void;
}

const NOOP_METRICS: RedisRealtimeSubscriberMetricsPort = {
  incrementDropped: () => undefined,
};

export interface CreateRedisRealtimeSubscriberOptions {
  /** A DEDICATED subscriber-mode connection - ioredis requires a separate client once `.subscribe()` is called on it (a connection in subscriber mode can no longer issue ordinary commands). */
  redis: Redis;
  env: string;
  hub: Pick<RealtimeHub, 'publish'>;
  logger: RedisRealtimeSubscriberLogger;
  metrics?: RedisRealtimeSubscriberMetricsPort;
}

export interface RedisRealtimeSubscriber {
  /** Subscribes `redis` to the one bridge channel and wires its `message` handler. Resolves once the SUBSCRIBE command completes. */
  start(): Promise<void>;
  /** Unsubscribes - does NOT close/quit the connection (the caller owns that, same as every other Redis handle in boot wiring). */
  stop(): Promise<void>;
}

/** Builds the API-side subscriber half of the bridge. */
export function createRedisRealtimeSubscriber(
  options: CreateRedisRealtimeSubscriberOptions,
): RedisRealtimeSubscriber {
  const { redis, env, hub, logger } = options;
  const metrics = options.metrics ?? NOOP_METRICS;
  const channel = sysKey(env, 'rt', 'bridge');

  function onBatchMessage(raw: Record<string, unknown>): void {
    const clientId = raw.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      metrics.incrementDropped();
      logger.warn('redis-bridge subscriber: dropped a batch frame with no clientId routing field');
      return;
    }

    const instanceId = raw.instanceId;
    const result = batchFrameSchema.safeParse(raw.frame);
    if (!result.success) {
      metrics.incrementDropped();
      logger.warn('redis-bridge subscriber: dropped a batch frame that failed schema validation');
      return;
    }

    for (const event of result.data.events) {
      // BUG FIX (P15 C1 FIX F6 / MAJ-4): `instanceId` used to be spread into
      // EVERY event in the group unconditionally - a strict schema without
      // that field (campaign.progress, job.needs_user_action,
      // webhook.endpoint_disabled) fails `hub.publish`'s own
      // `realtimeEventSchema.parse` (`.strict()` rejects the unrecognized
      // key), throwing synchronously from inside THIS loop and killing every
      // OTHER event in the same batch too. Inject `instanceId` only when the
      // event's own declared allow-list (`REALTIME_PAYLOAD_KEYS`, the same
      // list `emit()`/`hub.publish` already enforce) actually names it, and
      // never let one event's publish failure take down its siblings - the
      // transport must never throw, only count and move on.
      const allowedKeys = REALTIME_PAYLOAD_KEYS[event.type as RealtimePayloadEventType] as
        readonly string[] | undefined;
      const eventDeclaresInstanceId = allowedKeys?.includes('instanceId') ?? false;
      const publishInput = {
        ...event,
        clientId,
        ...(eventDeclaresInstanceId && typeof instanceId === 'string' ? { instanceId } : {}),
      } as Parameters<RealtimeHub['publish']>[0];

      try {
        hub.publish(publishInput);
      } catch {
        metrics.incrementDropped();
        logger.warn(
          'redis-bridge subscriber: dropped one event inside a batch frame that failed hub.publish validation',
        );
      }
    }
  }

  function onMessage(receivedChannel: string, message: string): void {
    if (receivedChannel !== channel) {
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      metrics.incrementDropped();
      // Never log the raw message - it may be garbage that happens to
      // contain a QR string or other sensitive fragment.
      logger.warn('redis-bridge subscriber: dropped a frame that was not valid JSON');
      return;
    }

    if (typeof raw !== 'object' || raw === null) {
      metrics.incrementDropped();
      logger.warn('redis-bridge subscriber: dropped a non-object frame');
      return;
    }

    // P15 U4 (step 5) - the relay's batch-frame leg. `publishBatch`'s wire
    // shape (`{kind:'batch', clientId, instanceId, frame}`) is tagged so it
    // never collides with the untagged single-event shape above. Forwards
    // every event inside the frame to the hub as its own `hub.publish` call
    // - see redis-bridge.batch.test.ts's own module doc for why (batching is
    // a wire-transport optimisation for THIS leg only).
    if ((raw as Record<string, unknown>).kind === 'batch') {
      onBatchMessage(raw as Record<string, unknown>);
      return;
    }

    // `clientId` rides alongside the validated event on the wire (this
    // module's own `publish` attaches it after validation - see above) but
    // is routing metadata, never part of the discriminated union's own
    // `.strict()` schema (mirrors hub.ts's `eventOnly` split) - it must be
    // stripped before `realtimeEventSchema` ever sees the frame, or every
    // frame fails validation with an "unrecognized key" error.
    const withRouting = raw as Record<string, unknown>;
    const clientId = withRouting.clientId;
    const eventOnly: Record<string, unknown> = { ...withRouting };
    delete eventOnly.clientId;

    const result = realtimeEventSchema.safeParse(eventOnly);
    if (!result.success) {
      metrics.incrementDropped();
      logger.warn('redis-bridge subscriber: dropped a frame that failed schema validation');
      return;
    }

    if (typeof clientId !== 'string' || clientId.length === 0) {
      metrics.incrementDropped();
      logger.warn('redis-bridge subscriber: dropped a frame with no clientId routing field');
      return;
    }

    hub.publish({
      ...result.data,
      clientId,
    } as Parameters<RealtimeHub['publish']>[0]);
  }

  return {
    async start(): Promise<void> {
      redis.on('message', onMessage);
      await redis.subscribe(channel);
    },

    async stop(): Promise<void> {
      redis.off('message', onMessage);
      await redis.unsubscribe(channel);
    },
  };
}
