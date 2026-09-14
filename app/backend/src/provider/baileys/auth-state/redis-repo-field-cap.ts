import type { Redis } from 'ioredis';
import type { WpLogger } from '@wp/server-kit';
import { applyFieldCap } from './field-cap-guard.js';
import { runWrite, withTimeout, type WithTimeoutOptions } from './redis-repo-timeout.js';

/**
 * Deliberately a LOCAL, minimal copy of `redis-repo.ts`'s `SignalRedisRepoRef`
 * shape (never imported back from `redis-repo.ts`) - that file imports THIS
 * one, so importing the type back would be a circular module dependency.
 */
export interface FieldCapRepoRef {
  clientId: string;
  instanceId: string;
}

/**
 * redis-repo-field-cap.ts (P10 Unit U5, step 6) - `runFieldCapCheck`: the one
 * per-hash-bucket call `redis-repo.ts`'s `setKeys` makes into the pure
 * `field-cap-guard.ts` before issuing the real fence-gated HSET, split out
 * purely to stay under the repo's `max-lines` guard (same reasoning as
 * `pg-repo.ts`/`pg-repo-keys.ts`'s own split). Owns the real ioredis
 * HMGET/HLEN/HRANDFIELD/HDEL calls `applyFieldCap`'s injected deps need;
 * `applyFieldCap` itself stays Redis-agnostic and unit-testable.
 */

export interface FieldCapWriteBucket {
  redis: Redis;
  tier: 'sig' | 'cache';
  key: string;
  keyType: string;
  sets: Record<string, Buffer>;
}

export interface RunFieldCapCheckDeps extends WithTimeoutOptions {
  maxFieldsPerInstance: number;
  fieldCapMetrics?: {
    incrementRedisSigFieldEvicted: () => void;
    incrementRedisSigFieldCapReached: () => void;
  };
  logger: WpLogger;
}

/**
 * Runs the field-cap guard for ONE (tier, hash) write bucket. Idempotency
 * (core invariant 3): only field ids NOT already present in the hash count
 * as "new" - a single bounded HMGET over exactly this batch's set-entry ids
 * (never a SCAN) is the presence check; a pure replay of already-present ids
 * yields zero "new" ids and this function returns immediately without
 * touching Redis again.
 *
 * Fail-safe (core invariant 2): the cap check is an alarm/isolation control
 * layered IN FRONT OF the real write, never a gate the write depends on. If
 * ANY part of the check throws for any reason (a missing/broken method on
 * the injected Redis client, a real Redis error, a timeout), that error is
 * caught here and never propagated - it is logged as a structured, ids-only
 * warning instead. Per ADR 0018 S5, a SIGNAL-tier write must NEVER be
 * blocked by this guard; losing a ratchet makes already-encrypted inbound
 * permanently unreadable, which is a far worse outcome than a missed/late
 * field-cap alarm.
 */
export async function runFieldCapCheck(
  bucket: FieldCapWriteBucket,
  ref: FieldCapRepoRef,
  deps: RunFieldCapCheckDeps,
): Promise<void> {
  try {
    const setEntries = Object.entries(bucket.sets);
    if (setEntries.length === 0) {
      return;
    }

    const setFieldIds = setEntries.map(([field]) => field);
    const existing = await withTimeout(
      () => bucket.redis.hmget(bucket.key, ...setFieldIds),
      'hmget',
      deps,
    );
    const newFieldIds = setFieldIds.filter((_, index) => existing[index] === null);

    await applyFieldCap(
      {
        currentCount: () => withTimeout(() => bucket.redis.hlen(bucket.key), 'hlen', deps),
        trimOneField: async (hashKey) => {
          // `hrandfield(key, 1)` (the COUNT overload) always resolves to
          // `string[] | null` - avoids the ambiguous no-count overload and
          // lets us pick exactly one field id to trim.
          const picked = await withTimeout<string[] | null>(
            () => bucket.redis.hrandfield(hashKey, 1) as Promise<string[] | null>,
            'hrandfield',
            deps,
          );
          const fieldId = picked?.[0];
          if (fieldId === undefined) {
            return null;
          }
          await runWrite(
            () => bucket.redis.hdel(hashKey, fieldId),
            'hdel',
            deps,
            'Failed to trim a REBUILDABLE-tier Signal auth-state field from Redis',
          );
          return fieldId;
        },
        onFieldEvicted: () => {
          deps.fieldCapMetrics?.incrementRedisSigFieldEvicted();
        },
        onCapReached: () => {
          deps.fieldCapMetrics?.incrementRedisSigFieldCapReached();
        },
        warn: (info) => {
          deps.logger.warn(
            { client_id: info.clientId, instance_id: info.instanceId, event_type: info.keyType },
            'redis-sig per-instance field cap reached - SIGNAL-tier write allowed (never trimmed, ADR 0018 S5)',
          );
        },
        maxFieldsPerInstance: deps.maxFieldsPerInstance,
      },
      {
        tier: bucket.tier,
        hashKey: bucket.key,
        keyType: bucket.keyType,
        clientId: ref.clientId,
        instanceId: ref.instanceId,
        newFieldIds,
      },
    );
  } catch (err) {
    // Fail-safe: never let a cap-check failure become the caller's error -
    // the caller's real (fence-gated) write must still proceed. Ids only,
    // no PII, no field values. Fields are restricted to the shared
    // `LogFields` allow-list (server-kit/obs/log-fields.ts) - `tier` is
    // folded into the message text (not a structured field) since the
    // allow-list has no `tier` key.
    deps.logger.warn(
      {
        client_id: ref.clientId,
        instance_id: ref.instanceId,
        event_type: bucket.keyType,
        error_class: err instanceof Error ? err.constructor.name : 'UnknownError',
      },
      `redis ${bucket.tier}-tier field-cap check failed (${
        err instanceof Error ? err.message : String(err)
      }) - proceeding with the write regardless (fail-safe, ADR 0018 S5)`,
    );
  }
}
