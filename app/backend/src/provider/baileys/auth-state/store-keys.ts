import { proto } from 'baileys';
import type { SignalDataSet } from 'baileys';
import { classifyAuthKeyType } from '@wp/domain';
import type { SealedBlob } from '@wp/server-kit/crypto';
import * as defaultPgRepo from './pg-repo.js';
import { DurableKeyWriteConflictError, FenceConflictError } from './types.js';
import type { AuthStoreIdentity, AuthStorePorts } from './types.js';
import type { AuthCodec, AuthRecordRef } from './codec.js';
import { RedisFenceGateError } from './redis-repo.js';
import type { SignalRedisRepo, SignalRedisRepoWrite } from './redis-repo.js';

/**
 * store-keys.ts (P07 Unit U5) - `runGetKeys`/`runSetKeys`: the durable
 * (Postgres)/signal+rebuildable (Redis) key routing halves of
 * `EncryptedAuthStore`, split out of `store.ts` purely to stay under the
 * repo's `max-lines` guard (same reasoning as `pg-repo.ts`/`pg-repo-keys.ts`
 * and `store.ts`/`store-purge.ts`'s own splits).
 */

export interface KeysDeps {
  db: Parameters<typeof defaultPgRepo.getKeys>[0];
  pgRepo: typeof defaultPgRepo;
  redisRepo: SignalRedisRepo;
  codec: AuthCodec;
  identity: AuthStoreIdentity;
  ports: AuthStorePorts;
  onDecryptFailure: (err: unknown) => void;
  selfFence: (cause?: 'fence_conflict' | 'epoch_conflict') => Promise<void>;
}

function durableRef(identity: AuthStoreIdentity, recordId: string, column: string): AuthRecordRef {
  return { table: 'whatsapp_session_keys', column, clientId: identity.clientId, recordId };
}

function signalRef(identity: AuthStoreIdentity, keyType: string, recordId: string): AuthRecordRef {
  return { table: 'redis_signal_keys', column: keyType, clientId: identity.clientId, recordId };
}

export async function runGetKeys<T extends string>(
  deps: KeysDeps,
  type: T,
  ids: string[],
): Promise<Record<string, unknown>> {
  const { db, pgRepo, redisRepo, codec, identity, onDecryptFailure } = deps;
  const tier = classifyAuthKeyType(type);
  const result: Record<string, unknown> = {};

  if (tier === 'durable') {
    const blobs = await pgRepo.getKeys(
      db,
      { instanceId: identity.instanceId, clientId: identity.clientId },
      type,
      ids,
    );
    for (const [id, blob] of blobs) {
      try {
        let value = codec.openAuthValue(
          blob,
          durableRef(identity, `${identity.instanceId}:${type}:${id}`, type),
        );
        if (type === 'app-state-sync-key' && value != null) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
        }
        result[id] = value;
      } catch (err) {
        onDecryptFailure(err);
        throw err;
      }
    }
    return result;
  }

  const buffers = await redisRepo.getKeys(
    { clientId: identity.clientId, instanceId: identity.instanceId },
    type,
    ids,
  );
  for (const [id, buf] of buffers) {
    const blob = codec.decodeSealedBlob(buf);
    try {
      result[id] = codec.openAuthValue(
        blob,
        signalRef(identity, type, `${identity.instanceId}:${id}`),
      );
    } catch (err) {
      onDecryptFailure(err);
      throw err;
    }
  }
  return result;
}

export async function runSetKeys(
  deps: KeysDeps,
  data: SignalDataSet,
  fence: bigint,
): Promise<void> {
  const { db, pgRepo, redisRepo, codec, identity, ports, selfFence } = deps;

  const durableWrites: { keyType: string; keyId: string; blob: SealedBlob | null }[] = [];
  const signalWrites: SignalRedisRepoWrite[] = [];

  for (const [type, byId] of Object.entries(data)) {
    if (!byId) continue;
    const tier = classifyAuthKeyType(type);
    for (const [id, value] of Object.entries(byId)) {
      if (tier === 'durable') {
        const blob =
          value === null || value === undefined
            ? null
            : codec.sealAuthValue(
                value,
                durableRef(identity, `${identity.instanceId}:${type}:${id}`, type),
              );
        durableWrites.push({ keyType: type, keyId: id, blob });
      } else {
        const buf =
          value === null || value === undefined
            ? null
            : codec.encodeSealedBlob(
                codec.sealAuthValue(
                  value,
                  signalRef(identity, type, `${identity.instanceId}:${id}`),
                ),
              );
        signalWrites.push({ keyType: type, keyId: id, value: buf });
      }
    }
  }

  if (durableWrites.length > 0) {
    const result = await pgRepo.setKeys(
      db,
      {
        instanceId: identity.instanceId,
        clientId: identity.clientId,
        fence,
        workerId: identity.workerId,
        sessionEpoch: identity.sessionEpoch,
      },
      durableWrites,
    );
    if (result.missed) {
      const missClass = await pgRepo.classifyWriteMiss(db, {
        instanceId: identity.instanceId,
        clientId: identity.clientId,
        expectedVersion: 0n,
        fence,
        workerId: identity.workerId,
        sessionEpoch: identity.sessionEpoch,
      });
      // WARNING-4: a missed durable-tier keys write must NEVER fall through
      // silently. 'fence_conflict'/'epoch_conflict' -> the same self-fence
      // path every other write uses. 'version_conflict' is meaningless for a
      // keys batch (there is no caller-supplied expected version to have
      // conflicted on) - throw a typed error rather than silently
      // continuing as if the write had landed; the throw IS the signal, no
      // new metric.
      if (missClass === 'fence_conflict' || missClass === 'epoch_conflict') {
        await selfFence(missClass);
        throw new FenceConflictError(identity.instanceId);
      }
      throw new DurableKeyWriteConflictError(identity.instanceId);
    }
  }

  if (signalWrites.length > 0) {
    // The signal path checks the fence BEFORE writing Redis: a fresh
    // `classifyWriteMiss`-style re-read against `instance_lease_state` (the
    // same live-fence source of truth `pg-repo.ts`'s classification uses)
    // proves this caller's fence is still current - a stale owner must not
    // be able to dirty Redis even though Redis itself has no fence column
    // of its own. This is a fast-path pre-check only - the REAL enforcement
    // against a takeover racing IN BETWEEN this check and the Redis write
    // itself is `redis-repo.ts`'s own atomic Lua fence gate (WARNING-3),
    // which `fence` is threaded into below.
    const missClass = await pgRepo.classifyWriteMiss(db, {
      instanceId: identity.instanceId,
      clientId: identity.clientId,
      expectedVersion: 0n,
      fence,
      workerId: identity.workerId,
      sessionEpoch: identity.sessionEpoch,
    });
    if (missClass === 'fence_conflict' || missClass === 'epoch_conflict') {
      await selfFence(missClass);
      throw new FenceConflictError(identity.instanceId);
    }

    try {
      await redisRepo.setKeys(
        { clientId: identity.clientId, instanceId: identity.instanceId },
        signalWrites,
        fence,
      );
    } catch (err) {
      if (err instanceof RedisFenceGateError) {
        await selfFence('fence_conflict');
        throw new FenceConflictError(identity.instanceId);
      }
      await ports.onSignalWriteFailure({ instanceId: identity.instanceId, error: err as Error });
      throw err;
    }
  }
}
