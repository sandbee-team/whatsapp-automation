/**
 * field-cap-guard.ts (P10 Unit U5, step 6) - the `REDIS_SIG_MAX_FIELDS_PER_
 * INSTANCE` per-instance field-count guard for `redis-repo.ts`'s `setKeys`.
 *
 * Tenant isolation (core invariant 4): the cap is enforced per (tier,
 * instance, key-type hash) - one broadcast-heavy tenant filling its own
 * hash(es) never affects another instance's cap check, because every count
 * read/trim below is scoped to the caller-supplied `hashKey` alone (never a
 * cross-instance aggregate, never a SCAN).
 *
 * Idempotency (core invariant 3): `newFieldCount` must only count field ids
 * that are NOT already present in the hash - re-setting an existing field id
 * (a replay) is zero new fields, never counted as growth. Callers compute
 * this by diffing the write batch's field ids against a `fieldExists` check
 * (typically one HLEN + a per-id presence check, or - when the caller already
 * knows the current size cheaply - just the post-write HLEN comparison; see
 * `redis-repo.ts`'s call site for the exact mechanism used against real
 * Redis).
 *
 * Two DIFFERENT semantics per tier (ADR 0018 S5 - redis-sig is `noeviction`;
 * losing a ratchet makes inbound permanently unreadable):
 *   - REBUILDABLE tier (`redisCache`, the `cache` param below): fields beyond
 *     the cap are TRIMMED via random eviction (WARNING 10, FIX-P10-A: Redis
 *     hashes carry no insertion order, so `trimOneField`'s real
 *     implementation - `HRANDFIELD` in `redis-repo-field-cap.ts` - is
 *     UNIFORM RANDOM, never "oldest-first"; this is acceptable because this
 *     tier is re-fetchable, never a data-loss risk) + `onFieldEvicted()`
 *     fires once per trimmed field. Safe: this tier is re-fetchable from the
 *     WhatsApp server, so a trim is a cache miss on the next read, never data
 *     loss.
 *   - SIGNAL tier (`redisSig`, the `sig` param below): fields at/beyond the
 *     cap are NEVER trimmed or dropped. `onCapReached()` fires (alarm +
 *     tenant-isolation signal only) and the write is ALWAYS allowed through.
 *     Fail-safe (core invariant 2): on any unclear/at-capacity state for this
 *     tier, the safe action is "keep the write", never "drop the ratchet".
 */

export type FieldCapTier = 'sig' | 'cache';

export interface FieldCapGuardDeps {
  /** Current field count of the target hash BEFORE this write's new fields land. */
  currentCount: (hashKey: string) => Promise<number>;
  /**
   * Trims exactly one field from `hashKey` to make room for the sig/cache
   * REBUILDABLE tier only - never called for the `sig` tier. Returns the
   * trimmed field id, or `null` if the hash was already empty (nothing to
   * trim - a fail-safe no-op, never an error).
   */
  trimOneField: (hashKey: string) => Promise<string | null>;
  onFieldEvicted: () => void;
  onCapReached: () => void;
  /** Ids-only structured warn (no PII) - `redis-repo.ts` binds this to the shared logger. */
  warn: (info: { clientId: string; instanceId: string; keyType: string }) => void;
  maxFieldsPerInstance: number;
}

export interface ApplyFieldCapArgs {
  tier: FieldCapTier;
  hashKey: string;
  keyType: string;
  clientId: string;
  instanceId: string;
  /** Field ids this write batch is about to HSET onto `hashKey` that are NOT already present (see module doc comment - idempotency). */
  newFieldIds: readonly string[];
}

/**
 * Enforces `maxFieldsPerInstance` for ONE (tier, hash) write batch, BEFORE
 * the caller issues the real HSET. For the `cache` tier, trims enough
 * existing fields (random eviction via `trimOneField` - Redis hashes carry
 * no insertion order, so this is never "oldest-first"; acceptable because
 * this tier is re-fetchable, see the module doc) to keep the projected
 * post-write count at or under the cap. For the `sig` tier, NEVER trims -
 * only alarms once (`onCapReached` + `warn`) per call where the projected
 * count would reach or exceed the cap.
 */
export async function applyFieldCap(
  deps: FieldCapGuardDeps,
  args: ApplyFieldCapArgs,
): Promise<void> {
  if (args.newFieldIds.length === 0) {
    // No new fields to make room for (a replay/idempotent resend of already-
    // present ids, or a delete-only batch) - nothing to check.
    return;
  }

  const current = await deps.currentCount(args.hashKey);
  const projected = current + args.newFieldIds.length;

  if (projected <= deps.maxFieldsPerInstance) {
    return;
  }

  if (args.tier === 'sig') {
    // Fail-safe (core invariant 2): alarm only, the write proceeds
    // regardless - a SIGNAL-tier field is never trimmed by this guard.
    deps.onCapReached();
    deps.warn({ clientId: args.clientId, instanceId: args.instanceId, keyType: args.keyType });
    return;
  }

  // REBUILDABLE tier: trim enough existing fields to bring the projected
  // count back to the cap. `trimOneField` returning `null` means the hash is
  // already empty - stop rather than loop forever (fail-safe: an unclear/
  // already-empty state is never treated as an error here).
  let overBy = projected - deps.maxFieldsPerInstance;
  while (overBy > 0) {
    const trimmed = await deps.trimOneField(args.hashKey);
    if (trimmed === null) {
      break;
    }
    deps.onFieldEvicted();
    overBy -= 1;
  }
}
