import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/signal-metrics.ts (P07 Unit U5, step 8) - registers the
 * four Signal-keystore Prometheus metrics `makeBoundedSignalKeyStore` and
 * `EncryptedAuthStore`'s decrypt path need, following the exact idempotent-
 * registration pattern of `lease-metrics.ts`'s `bindLeaseMetrics` (a
 * `WeakMap` keyed by the registry makes a second `bindSignalMetrics` call for
 * the SAME registry a safe no-op):
 *
 *   - `wp_signal_keystore_hit_total` (counter, no label) - the bounded
 *     in-memory LRU/TTL cache in `bounded-key-store.ts` served a `get()`
 *     without falling through to the underlying `EncryptedAuthStore`.
 *   - `wp_signal_keystore_miss_total` (counter, no label) - a `get()` fell
 *     through (cold cache, evicted, or TTL-expired) and had to read the
 *     store.
 *   - `wp_signal_keystore_evicted_total` (counter, no label) - an LRU
 *     insert past `maxEntries` evicted an existing cache entry (the entry
 *     was already written through, so it stays readable from the store).
 *   - `wp_signal_decrypt_failure_total{cause}` (counter) - incremented by
 *     `store.ts`'s `loadCreds`/`getKeys` on every `codec.openAuthValue`
 *     failure; `cause` is one of `'key_unavailable' | 'purpose_mismatch' |
 *     'auth_failed' | 'other'` (derived from the thrown `CryptoError`'s
 *     `code`) - `cause` is already on `ALLOWED_LABELS`. No client_id/
 *     instance_id labels on any of the four (metric-policy allow-list).
 *
 * P10 Unit U5 (step 6) adds two more, same no-label-cardinality shape, for
 * the `REDIS_SIG_MAX_FIELDS_PER_INSTANCE` field-cap guard (ADR 0018 S5 -
 * redis-sig is `noeviction`, so the SIGNAL tier is an alarm, never a
 * dropper):
 *   - `wp_auth_state_field_evicted_total` (counter, no label; WARNING 8,
 *     FIX-P10-A: renamed from `wp_redis_sig_field_evicted_total` - by design
 *     `field-cap-guard.ts` returns before the trim loop for the `sig` tier,
 *     so this counter fires EXCLUSIVELY for `tier === 'cache'` evictions; the
 *     old `..._sig_...` name would mislead an operator paging on it into
 *     thinking SIGNAL-tier ratchets could be dropped, which by design they
 *     never are) - a REBUILDABLE-tier field was trimmed because a
 *     per-instance hash grew past the cap (safe: rebuildable data is
 *     re-fetchable, never a data loss).
 *   - `wp_redis_sig_field_cap_reached_total` (counter, no label; name
 *     unchanged - this one genuinely IS sig-tier only) - a SIGNAL-tier
 *     (session/sender-key/identity-key) write landed at/beyond the
 *     per-instance cap. The write is ALWAYS allowed through - this counter is
 *     an alarm + tenant-isolation signal only, never an eviction.
 */

export interface SignalMetricsHandles {
  hitTotal: ReturnType<MetricsRegistry['counter']>;
  missTotal: ReturnType<MetricsRegistry['counter']>;
  evictedTotal: ReturnType<MetricsRegistry['counter']>;
  decryptFailureTotal: ReturnType<MetricsRegistry['counter']>;
  redisSigFieldEvictedTotal: ReturnType<MetricsRegistry['counter']>;
  redisSigFieldCapReachedTotal: ReturnType<MetricsRegistry['counter']>;
  incrementHit: () => void;
  incrementMiss: () => void;
  incrementEvicted: () => void;
  incrementDecryptFailure: (
    cause: 'key_unavailable' | 'purpose_mismatch' | 'auth_failed' | 'other',
  ) => void;
  /** REBUILDABLE-tier field trimmed at the redis-sig per-instance field cap. */
  incrementRedisSigFieldEvicted: () => void;
  /** SIGNAL-tier write landed at/beyond the redis-sig per-instance field cap - alarm only, write still allowed. */
  incrementRedisSigFieldCapReached: () => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, SignalMetricsHandles>();

export function bindSignalMetrics(
  registry: MetricsRegistry = defaultMetrics,
): SignalMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const hitTotal = registry.counter(
    'wp_signal_keystore_hit_total',
    'Bounded Signal key-store in-memory cache hits',
  );
  const missTotal = registry.counter(
    'wp_signal_keystore_miss_total',
    'Bounded Signal key-store in-memory cache misses (cold, evicted, or TTL-expired)',
  );
  const evictedTotal = registry.counter(
    'wp_signal_keystore_evicted_total',
    'Bounded Signal key-store LRU evictions past the tracked-devices cap',
  );
  const decryptFailureTotal = registry.counter(
    'wp_signal_decrypt_failure_total',
    'Auth-state decrypt (open) failures, by cause',
    ['cause'],
  );
  const redisSigFieldEvictedTotal = registry.counter(
    'wp_auth_state_field_evicted_total',
    'REBUILDABLE-tier (cache-only) redis-sig fields trimmed at the per-instance field cap',
  );
  const redisSigFieldCapReachedTotal = registry.counter(
    'wp_redis_sig_field_cap_reached_total',
    'SIGNAL-tier redis-sig writes at/beyond the per-instance field cap (alarm only, write always allowed)',
  );

  const handles: SignalMetricsHandles = {
    hitTotal,
    missTotal,
    evictedTotal,
    decryptFailureTotal,
    redisSigFieldEvictedTotal,
    redisSigFieldCapReachedTotal,
    incrementHit: () => {
      hitTotal.inc();
    },
    incrementMiss: () => {
      missTotal.inc();
    },
    incrementEvicted: () => {
      evictedTotal.inc();
    },
    incrementDecryptFailure: (cause) => {
      decryptFailureTotal.inc({ cause });
    },
    incrementRedisSigFieldEvicted: () => {
      redisSigFieldEvictedTotal.inc();
    },
    incrementRedisSigFieldCapReached: () => {
      redisSigFieldCapReachedTotal.inc();
    },
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
