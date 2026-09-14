import { CryptoError } from '@wp/server-kit';
import { makeBoundedSignalKeyStore } from './bounded-key-store.js';
import * as defaultPgRepo from './pg-repo.js';
import { runGetKeys, runSetKeys } from './store-keys.js';
import { runPurge } from './store-purge.js';
import type { AuthRecordRef } from './codec.js';
import {
  CredsSaveExhaustedError,
  FenceConflictError,
  StoreFencedError,
  type AuthStoreIdentity,
  type CreateEncryptedAuthStoreDeps,
  type EncryptedAuthStore,
  type PurgeResult,
  type SaveCredsArgs,
} from './types.js';
import type { SignalDataSet, SignalKeyStore } from 'baileys';

/**
 * store.ts (P07 Unit U5, step 7) - `createEncryptedAuthStore`: the
 * `EncryptedAuthStore` implementation routing every Baileys auth-state key
 * through `classifyAuthKeyType()` to either the Postgres repo (durable tier)
 * or the Signal Redis repo (signal/rebuildable tiers), all values sealed/
 * opened through the injected `AuthCodec` (DECIDED FACT 5).
 *
 * SAFETY BOUNDARY (same class as `types.ts`'s own header): NO health-state
 * writes, NO socket references, NO logout/unlink/re-pair logic anywhere in
 * this file. `purge` is our own state deletion only.
 *
 * `db` must additionally support `.connect()` (a `pg.Pool`-shaped
 * dependency, `SessionStoreDb` from `types.ts`) ONLY for `purge`'s one
 * Postgres transaction - every other method uses the plain
 * `SessionRepoQueryable.query` surface.
 */

const MAX_SAVE_CREDS_RETRIES = 3;

function toFence(fence: bigint | number): bigint {
  return typeof fence === 'bigint' ? fence : BigInt(fence);
}

function credsRef(identity: AuthStoreIdentity): AuthRecordRef {
  return {
    table: 'whatsapp_session_credentials',
    column: 'ciphertext',
    clientId: identity.clientId,
    recordId: identity.instanceId,
  };
}

/** Derives the `wp_signal_decrypt_failure_total{cause}` label from a thrown error's code. */
function classifyDecryptFailureCause(
  err: unknown,
): 'key_unavailable' | 'purpose_mismatch' | 'auth_failed' | 'other' {
  if (err instanceof CryptoError) {
    if (err.code === 'CRYPTO_KEY_UNAVAILABLE') return 'key_unavailable';
    if (err.code === 'CRYPTO_PURPOSE_MISMATCH') return 'purpose_mismatch';
    if (err.code === 'CRYPTO_DECRYPT_FAILED') return 'auth_failed';
  }
  return 'other';
}

/**
 * Builds an `EncryptedAuthStore` bound to `deps`. FIX-A CRITICAL-1(a): EVERY
 * store mutation (`saveCreds`, `setKeys`, `purge`) is serialised behind ONE
 * per-instance promise chain (`chainTail`) so 20 concurrent callers of ANY
 * mix of these three land as strictly sequential writes, never a torn/
 * interleaved cred_version bump and never a purge racing a concurrent
 * saveCreds/setKeys. A throw from any chained attempt must never wedge the
 * chain for the next caller - see `runChained`'s swallow-then-rethrow shape.
 */
export function createEncryptedAuthStore(deps: CreateEncryptedAuthStoreDeps): EncryptedAuthStore {
  const { db, redisRepo, codec, identity, ports, metrics, signalKeystoreMaxRecords } = deps;
  const pgRepo = deps.pgRepo ?? defaultPgRepo;

  let fenced = false;
  let chainTail: Promise<void> = Promise.resolve();

  function assertNotFenced(): void {
    if (fenced) {
      throw new StoreFencedError(identity.instanceId);
    }
  }

  /** Self-fences this store: every subsequent write throws `StoreFencedError`. */
  async function selfFence(
    cause: 'fence_conflict' | 'epoch_conflict' = 'fence_conflict',
  ): Promise<void> {
    fenced = true;
    await ports.onFenceConflict({ instanceId: identity.instanceId, cause });
    await ports.releaseLease();
  }

  /**
   * FIX-B WARNING: marks this store terminally fenced after a SUCCESSFUL
   * purge (`{purged: true}` - a real purge - or `{purged: false}` - a
   * benign replay of an already-applied purge; both land in the SAME
   * terminal state, see `PurgeResult`'s doc comment) WITHOUT calling
   * `ports.onFenceConflict`/`ports.releaseLease`. This is deliberately NOT
   * `selfFence`: a self-purge is not a fence loss (nobody else took over
   * this instance - THIS caller purged its own session on purpose), so it
   * must never report a fence-conflict cause or release the lease as a
   * side effect. The caller still owns lease release through its own
   * normal flow after `purge()` resolves - purge itself never releases it.
   * Every subsequent write (`saveCreds`/`setKeys`/a second `purge`) throws
   * `StoreFencedError` exactly like the fence-conflict terminal state does.
   */
  function markPurged(): void {
    fenced = true;
  }

  /**
   * Runs `attempt` behind the single per-instance `chainTail` - callers
   * queued behind a slow/failing predecessor still run strictly after it,
   * and a rejection from `attempt` propagates to THIS caller only, never to
   * the next one queued behind it (the chain tail itself is swallowed so it
   * never becomes a permanently-rejected promise that would wedge every
   * future call).
   */
  function runChained<T>(attempt: () => Promise<T>): Promise<T> {
    const runNext = chainTail.then(attempt, attempt);
    chainTail = runNext.then(
      () => undefined,
      () => undefined,
    );
    return runNext;
  }

  async function loadCreds(): Promise<unknown | null> {
    const loaded = await pgRepo.loadCreds(db, {
      instanceId: identity.instanceId,
      clientId: identity.clientId,
    });
    if (!loaded) {
      return null;
    }
    try {
      return codec.openAuthValue(loaded.blob, credsRef(identity));
    } catch (err) {
      metrics.incrementDecryptFailure(classifyDecryptFailureCause(err));
      throw err;
    }
  }

  /** The actual save attempt body, run inside the serialising chain below. */
  async function saveCredsAttempt(args: SaveCredsArgs): Promise<{ credVersion: bigint }> {
    assertNotFenced();

    let expectedVersion = toFence(args.expectedVersion);
    const fence = toFence(args.fence);
    let attempt = 0;

    for (;;) {
      const blob = codec.sealAuthValue(args.creds, credsRef(identity));
      const result = await pgRepo.saveCreds(db, {
        instanceId: identity.instanceId,
        clientId: identity.clientId,
        blob,
        sessionEpoch: identity.sessionEpoch,
        expectedVersion,
        fence,
        workerId: identity.workerId,
      });

      if (result !== null) {
        return { credVersion: result.credVersion };
      }

      const missClass = await pgRepo.classifyWriteMiss(db, {
        instanceId: identity.instanceId,
        clientId: identity.clientId,
        expectedVersion,
        fence,
        workerId: identity.workerId,
        sessionEpoch: identity.sessionEpoch,
      });

      if (missClass === 'fence_conflict' || missClass === 'epoch_conflict') {
        await selfFence(missClass);
        throw new FenceConflictError(identity.instanceId);
      }

      // version_conflict: reload and retry the SAME creds payload with the
      // fresh expectedVersion, up to MAX_SAVE_CREDS_RETRIES total. Never
      // calls a port for this class - it is an ordinary optimistic-
      // concurrency retry, not a fence loss.
      attempt += 1;
      if (attempt >= MAX_SAVE_CREDS_RETRIES) {
        throw new CredsSaveExhaustedError(identity.instanceId, MAX_SAVE_CREDS_RETRIES);
      }

      const reloaded = await pgRepo.loadCreds(db, {
        instanceId: identity.instanceId,
        clientId: identity.clientId,
      });
      expectedVersion = reloaded ? reloaded.credVersion : 0n;
    }
  }

  /** Serialises all `saveCreds` calls for this instance behind the shared chain. */
  function saveCreds(args: SaveCredsArgs): Promise<{ credVersion: bigint }> {
    return runChained(() => saveCredsAttempt(args));
  }

  /** FIX-A (P26 C1 review) - see `types.ts#EncryptedAuthStore.currentCredVersion`'s doc comment. */
  async function currentCredVersion(): Promise<bigint> {
    const loaded = await pgRepo.loadCreds(db, {
      instanceId: identity.instanceId,
      clientId: identity.clientId,
    });
    return loaded ? loaded.credVersion : 0n;
  }

  const keysDeps = {
    db,
    pgRepo,
    redisRepo,
    codec,
    identity,
    ports,
    onDecryptFailure: (err: unknown) => {
      metrics.incrementDecryptFailure(classifyDecryptFailureCause(err));
    },
    selfFence,
  };

  async function getKeys<T extends string>(
    type: T,
    ids: string[],
  ): Promise<Record<string, unknown>> {
    return runGetKeys(keysDeps, type, ids);
  }

  function setKeys(data: SignalDataSet, fenceArg?: bigint | number): Promise<void> {
    return runChained(async () => {
      assertNotFenced();
      const fence = fenceArg === undefined ? identity.fence : toFence(fenceArg);
      await runSetKeys(keysDeps, data, fence);
    });
  }

  function purge(fenceArg: bigint | number): Promise<PurgeResult> {
    return runChained(async () => {
      assertNotFenced();
      const fence = toFence(fenceArg);
      // The transaction body lives in `store-purge.ts` (split purely to stay
      // under the repo's `max-lines` guard, same reasoning as `pg-repo.ts`/
      // `pg-repo-keys.ts`) - `selfFence` is passed through so a stale-fence
      // outcome still self-fences THIS store instance exactly like every
      // other write path.
      const result = await runPurge(
        { db, redisRepo, identity, selfFence, onEpochAdvanced: deps.onEpochAdvanced },
        fence,
      );
      // FIX-B WARNING: a SUCCESSFUL purge (real or benign-replay) leaves
      // this store's OWN state stale - the durable rows it may have deleted
      // are gone, and the epoch has moved - even though nobody else took
      // over the instance. `markPurged` marks the store terminally fenced
      // for that reason, WITHOUT the fence-conflict port calls `selfFence`
      // makes (see `markPurged`'s own doc comment).
      markPurged();
      return result;
    });
  }

  function asSignalKeyStore(): SignalKeyStore {
    return makeBoundedSignalKeyStore({ store, metrics, maxEntries: signalKeystoreMaxRecords });
  }

  const store: EncryptedAuthStore = {
    loadCreds,
    saveCreds,
    currentCredVersion,
    getKeys,
    setKeys,
    purge,
    asSignalKeyStore,
  };

  return store;
}
