import type { SignalDataSet, SignalKeyStore } from 'baileys';
import type { SessionRepoQueryable } from './pg-repo.js';
import type { SignalRedisRepo } from './redis-repo.js';
import type { AuthCodec } from './codec.js';
import type { SignalMetricsHandles } from '../../../platform/metrics/signal-metrics.js';

/**
 * types.ts (P07 Unit U5, step 7) - the `EncryptedAuthStore` contract and its
 * dependency/port shapes (DECIDED FACT 4). This module (and `store.ts`,
 * which implements it) must contain NO health-state writes of any kind
 * (leaving `health_state` untouched is proven by absence + `AuthStorePorts`
 * being the only escape hatch), NO socket references, and NO logout/unlink/
 * re-pair logic - `purge` is our OWN state deletion; it must never reach for
 * `sock.logout()`/`sock.unlink()`, and nothing here may become an
 * auto-recover-by-re-pairing path (safety boundary, same class as core
 * invariant 6). NO SCAN/KEYS/HGETALL either (inherited from `redis-repo.ts`'s
 * own boundary - `store.ts` only ever calls `redisRepo`'s bounded methods).
 */

/**
 * The three escape hatches `createEncryptedAuthStore` calls out to - never
 * health-state writes, never a socket, never a retry loop of its own.
 */
export interface AuthStorePorts {
  /** Called exactly once when this store self-fences (a fence conflict was detected on a write). */
  onFenceConflict(info: {
    instanceId: string;
    cause: 'fence_conflict' | 'epoch_conflict';
  }): Promise<void>;
  /** Called exactly once per `SignalStateWriteError` from the Redis repo - degrade is the caller's job. */
  onSignalWriteFailure(info: { instanceId: string; error: Error }): Promise<void>;
  /** Releases the held `SessionLease` - the composition root binds this to `LeaseManager.release`. */
  releaseLease(): Promise<void>;
}

export interface AuthStoreIdentity {
  instanceId: string;
  clientId: string;
  sessionEpoch: number;
  fence: bigint;
  env: string;
  /**
   * The lease holder's worker id (FIX-A CRITICAL-2) - carried so every write
   * statement's lease `EXISTS` predicate can additionally require
   * `ls.owner_worker_id = $worker_id`. A released/stolen lease (mint clears
   * the PREVIOUS owner's `owner_worker_id`, release nulls it - see
   * `lease-mint-fence.sql`/`lease-release.sql`) then fails every predicate at
   * the storage layer even if a stale in-memory `fence` value still matches
   * numerically.
   */
  workerId: string;
}

/**
 * A `pg.Pool`-shaped dependency: the plain `SessionRepoQueryable.query`
 * surface every other method uses, PLUS `.connect()` for `purge`'s one
 * hand-rolled Postgres transaction (BEGIN/the deletes/the epoch bump/the
 * audit row/COMMIT - see `store.ts`'s `purge`).
 */
export interface SessionStoreDb extends SessionRepoQueryable {
  connect(): Promise<{
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
    release(err?: Error): void;
  }>;
}

export interface CreateEncryptedAuthStoreDeps {
  db: SessionStoreDb;
  pgRepo?: typeof import('./pg-repo.js');
  redisRepo: SignalRedisRepo;
  codec: AuthCodec;
  identity: AuthStoreIdentity;
  ports: AuthStorePorts;
  metrics: SignalMetricsHandles;
  /**
   * P10 Unit U5 (step 6): threads `config.SIGNAL_KEYSTORE_MAX_RECORDS` into
   * `asSignalKeyStore()`'s `makeBoundedSignalKeyStore` call. Optional - the
   * domain-constant default (`MAX_TRACKED_GROUP_PARTICIPANT_DEVICES`) inside
   * `makeBoundedSignalKeyStore` itself remains the deps-absent fallback, so
   * every caller that has not been updated to pass config keeps working
   * unchanged.
   */
  signalKeystoreMaxRecords?: number;
  /**
   * P23 Unit U6 (step 7) - invoked by `purge` AFTER the real-purge COMMIT
   * that bumped `session_epoch` (never before, never on the benign-replay
   * no-op path where the epoch was not actually bumped again). Errors are
   * caught and logged with ids only inside `store-purge.ts#runPurge` itself
   * - this callback can never break the purge path it rides on. Optional so
   * every existing caller that has not wired the sweep keeps compiling.
   */
  onEpochAdvanced?: (info: {
    clientId: string;
    instanceId: string;
    sessionEpoch: number;
  }) => void | Promise<void>;
}

export interface SaveCredsArgs {
  creds: unknown;
  expectedVersion: bigint | number;
  fence: bigint | number;
}

/**
 * `purge`'s result (C2-F1: purge is idempotent). `purged: false` means this
 * call was a no-op replay of an already-applied purge (both durable deletes
 * found nothing to remove) - the epoch was NOT bumped again and NO second
 * audit row was inserted; Redis purge still ran (its own DELs are
 * idempotent). Never an error - a replayed purge is a normal, expected
 * outcome (core invariant 3).
 *
 * FIX-B WARNING: EITHER outcome (`purged: true` - a real purge - OR
 * `purged: false` - a benign replay) leaves the store instance terminally
 * fenced afterwards - `store.ts`'s `purge` calls `markPurged()` on success,
 * setting the SAME internal `fenced` flag `selfFence` sets. This is
 * deliberate: `epoch_conflict` would otherwise be dishonest here (it implies
 * a TAKEOVER - someone else's write raced ahead - but a self-purge means
 * THIS caller removed its own session on purpose, nobody took over). The
 * distinction that matters: `markPurged` does NOT call
 * `ports.onFenceConflict`/`ports.releaseLease` the way a real fence-conflict
 * self-fence does - purge does NOT release the lease as a side effect; the
 * caller still owns releasing it through its own normal flow once `purge()`
 * resolves. Every subsequent `saveCreds`/`setKeys`/`purge` call on this store
 * instance throws `StoreFencedError` regardless of which purge outcome
 * triggered it. `loadCreds`/`getKeys` are read-only and are NOT gated by
 * `assertNotFenced` - see `store.ts`; their post-purge behavior is simply
 * "read whatever is currently there" (nothing after a real purge, whatever a
 * benign replay's still-live rows are), which is coherent and requires no
 * special-casing.
 */
export interface PurgeResult {
  purged: boolean;
}

/**
 * The store this phase builds. `loadCreds`/`getKeys` are read-only (no fence
 * enforcement needed - see `pg-repo.ts`'s own query header comments);
 * `saveCreds`/`setKeys`/`purge` all take and enforce a fence.
 */
export interface EncryptedAuthStore {
  loadCreds(): Promise<unknown | null>;
  saveCreds(args: SaveCredsArgs): Promise<{ credVersion: bigint }>;
  /**
   * FIX-A (P26 C1 review, CRITICAL 1) - the store's current `cred_version`
   * for this instance, `0n` (the upsert SQL's own documented "first save of
   * a new instance" sentinel) when no row exists yet. Read-only, no fence
   * enforcement (same class as `loadCreds`) - a caller uses this ONLY to
   * seed the correct `expectedVersion` for its next `saveCreds`, never to
   * decide whether a write is allowed.
   */
  currentCredVersion(): Promise<bigint>;
  getKeys<T extends string>(type: T, ids: string[]): Promise<Record<string, unknown>>;
  /**
   * `fence` defaults to this store's own held fence (`identity.fence`) when
   * omitted - the shape Baileys' `SignalKeyStore.set(data)` needs, via
   * `bounded-key-store.ts`. An explicit `fence` is accepted so a caller
   * built at a DIFFERENT (e.g. stale) fence can still be exercised directly
   * (see `fence.integration.test.ts`'s stale-owner case) - it is enforced
   * exactly the same way either way, never a bypass.
   */
  setKeys(data: SignalDataSet, fence?: bigint | number): Promise<void>;
  /** See `PurgeResult`'s doc comment - a replayed purge returns `{ purged: false }` rather than throwing. */
  purge(fence: bigint | number): Promise<PurgeResult>;
  /** Builds the bounded Baileys `SignalKeyStore` view over this store - see `bounded-key-store.ts`. */
  asSignalKeyStore(): SignalKeyStore;
}

/** Thrown when a `saveCreds` retry loop exhausts its 3 attempts still hitting `version_conflict`. */
export class CredsSaveExhaustedError extends Error {
  constructor(instanceId: string, attempts: number) {
    super(
      `saveCreds: exhausted ${String(attempts)} version-conflict retries for instance ${instanceId}`,
    );
    this.name = 'CredsSaveExhaustedError';
  }
}

/** Thrown to the immediate caller of a write once a fence conflict is detected. Never retried here. */
export class FenceConflictError extends Error {
  constructor(instanceId: string) {
    super(`fence conflict: instance ${instanceId} is no longer owned by this store's fence`);
    this.name = 'FenceConflictError';
  }
}

/** Thrown by EVERY write once this store has self-fenced (see `FenceConflictError`'s call site). */
export class StoreFencedError extends Error {
  constructor(instanceId: string) {
    super(`store for instance ${instanceId} is fenced - no further writes are accepted`);
    this.name = 'StoreFencedError';
  }
}

/**
 * Thrown when a `setKeys` durable-tier write misses and `classifyWriteMiss`
 * reports `'version_conflict'` (WARNING-4) - meaningless for keys (there is
 * no caller-supplied expected version for a keys batch), so a version-shaped
 * miss on a keys write can only mean the re-read itself raced or the
 * classification is stale. Never silently swallowed: the caller must see
 * this as a hard, typed failure rather than a silent no-op.
 */
export class DurableKeyWriteConflictError extends Error {
  constructor(instanceId: string) {
    super(
      `setKeys: durable-tier write for instance ${instanceId} missed with an unclassifiable ` +
        "('version_conflict') outcome - keys writes have no meaningful version to conflict on",
    );
    this.name = 'DurableKeyWriteConflictError';
  }
}
