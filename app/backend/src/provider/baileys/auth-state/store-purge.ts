import { bindQueryParams, loadQuery } from '@wp/db';
import { logger } from '@wp/server-kit';
import * as provisioningRepo from '../../../modules/tenancy/provisioning.repo.js';
import { FenceConflictError } from './types.js';
import type { AuthStoreIdentity, PurgeResult, SessionStoreDb } from './types.js';
import type { SignalRedisRepo } from './redis-repo.js';

interface LeaseValidityRow extends Record<string, unknown> {
  is_valid: boolean;
}

/**
 * store-purge.ts (P07 Unit U5, hardened FIX-A C2-F1) - `purge`'s one
 * Postgres transaction, split out of `store.ts` purely to stay under the
 * repo's `max-lines` guard (same reasoning as `pg-repo.ts`/`pg-repo-keys.ts`'s
 * own split). ONE transaction: fence-predicated DELETE on both durable
 * session tables (`session-purge-durable-creds.sql`/
 * `session-purge-durable-keys.sql`, the same statements `pg-repo.ts`'s
 * `purgeDurable` uses) plus a fence-predicated `session_epoch` bump
 * (`session-purge-epoch-bump.sql`) plus ONE audit row (reusing
 * `modules/tenancy/provisioning.repo.ts`'s `insertAuditLog` - the existing
 * audit-log writer, per the task's "reuse its table/writer" instruction).
 * Zero rows on the epoch bump -> rollback the WHOLE transaction (never just
 * skip the epoch bump) and report a stale fence to the caller, which
 * self-fences exactly like every other write path.
 *
 * IDEMPOTENCY (C2-F1, core invariant 3): a REPLAYED purge (same fence, same
 * instance, run again after a successful purge already committed) must be a
 * true no-op - it must NOT bump `session_epoch` a second time and must NOT
 * insert a second audit row. The two fence-predicated deletes run FIRST;
 * their combined `credsDeleted + keysDeleted` row count of exactly 0 is
 * AMBIGUOUS on its own (same "zero rows, two opposite meanings" shape as
 * `saveCreds`'s own miss - see `pg-repo.ts`'s `classifyWriteMiss` header): it
 * can mean either "this caller's fence/owner is no longer the live one" (a
 * genuine stale-fence rejection) or "a PRIOR purge already removed these
 * rows and the lease is still live" (a benign replay). `session-lease-is-
 * valid.sql` (the SAME tenant+fence+owner predicate every write statement's
 * lease EXISTS subquery uses, read-only) resolves the ambiguity: fence/owner
 * still valid -> benign replay, short-circuit BEFORE the epoch bump/audit
 * insert, roll back (nothing to roll back - the deletes were zero-row no-ops
 * anyway) and return `{ purged: false }`; fence/owner no longer valid -> the
 * existing genuine-stale-fence path (rollback + self-fence + throw) below.
 * Redis purge still runs unconditionally on the benign-replay path (its DELs
 * are themselves idempotent, so running them again against already-purged
 * keys is always safe) - it does NOT run on the genuine-stale-fence path
 * (self-fence throws first, mirroring every other write's fail-closed
 * behavior).
 *
 * After a REAL purge's COMMIT succeeds: `redisRepo.purgeInstance` (bounded
 * DELs). A crash between commit and this DEL leaves orphan Redis hashes that
 * expire by their own TTL (`SIGNAL_KEY_TTL_MS`) and are unreferenced after
 * the epoch bump (a future store for this instance is built at a newer fence
 * and a bumped `session_epoch`, so it never reads these orphaned hashes even
 * if they are still technically present until they expire).
 */

export interface RunPurgeDeps {
  db: SessionStoreDb;
  redisRepo: SignalRedisRepo;
  identity: AuthStoreIdentity;
  selfFence: (cause?: 'fence_conflict' | 'epoch_conflict') => Promise<void>;
  /** P23 Unit U6 (step 7) - see `types.ts#CreateEncryptedAuthStoreDeps.onEpochAdvanced`'s own doc for the full contract (after-COMMIT only, errors caught here, never rethrown). */
  onEpochAdvanced?: (info: {
    clientId: string;
    instanceId: string;
    sessionEpoch: number;
  }) => void | Promise<void>;
}

export async function runPurge(deps: RunPurgeDeps, fence: bigint): Promise<PurgeResult> {
  const { db, redisRepo, identity } = deps;

  const client = await db.connect();
  let committed = false;
  let staleFence = false;
  let noOpReplay = false;
  let bumpedSessionEpoch: number | undefined;
  try {
    await client.query('BEGIN');

    const credsQuery = await loadQuery('session-purge-durable-creds');
    const credsParams = bindQueryParams(credsQuery, {
      instance_id: identity.instanceId,
      client_id: identity.clientId,
      fence: fence.toString(),
      worker_id: identity.workerId,
    });
    const credsResult = await client.query(credsQuery.text, credsParams);

    const keysQuery = await loadQuery('session-purge-durable-keys');
    const keysParams = bindQueryParams(keysQuery, {
      instance_id: identity.instanceId,
      client_id: identity.clientId,
      fence: fence.toString(),
      worker_id: identity.workerId,
    });
    const keysResult = await client.query(keysQuery.text, keysParams);

    const totalDeleted = (credsResult.rowCount ?? 0) + (keysResult.rowCount ?? 0);

    if (totalDeleted === 0) {
      // C2-F1: nothing was actually removed by either delete - disambiguate
      // via the SAME tenant+fence+owner predicate every write statement's
      // lease EXISTS subquery uses (read-only, no side effects).
      const validityQuery = await loadQuery('session-lease-is-valid');
      const validityParams = bindQueryParams(validityQuery, {
        instance_id: identity.instanceId,
        client_id: identity.clientId,
        fence: fence.toString(),
        worker_id: identity.workerId,
      });
      const validityResult = await client.query<LeaseValidityRow>(
        validityQuery.text,
        validityParams,
      );

      if (validityResult.rows[0]?.is_valid === true) {
        // Fence/owner still live - a benign replay of an already-applied
        // purge. Commit nothing (there is nothing to commit - both deletes
        // were zero-row no-ops), skip the epoch bump AND the audit row, and
        // report a true no-op rather than a stale-fence rejection.
        await client.query('ROLLBACK');
        noOpReplay = true;
      } else {
        // Fence/owner no longer valid - a genuine stale-fence purge attempt
        // that happened to find nothing to delete either way (e.g. an
        // instance with no durable rows yet). Same rejection path as a
        // zero-row epoch bump below.
        await client.query('ROLLBACK');
        staleFence = true;
      }
    } else {
      const epochQuery = await loadQuery('session-purge-epoch-bump');
      const epochParams = bindQueryParams(epochQuery, {
        instance_id: identity.instanceId,
        client_id: identity.clientId,
        fence: fence.toString(),
        worker_id: identity.workerId,
      });
      const epochResult = await client.query<{ session_epoch: number }>(
        epochQuery.text,
        epochParams,
      );

      if (epochResult.rows.length === 0) {
        // Zero rows on the epoch bump -> rollback the WHOLE transaction (a
        // stale fence's purge must not silently keep any deletes it may have
        // made above). NEVER `return` here directly: this branch is inside
        // the `try`, and the post-release `if (staleFence)` check below is
        // the only place `selfFence()`/the throw may run, so `committed`
        // must stay `false` and control must reach the `finally` normally.
        await client.query('ROLLBACK');
        staleFence = true;
      } else {
        await provisioningRepo.insertAuditLog(client, {
          clientId: identity.clientId,
          actorType: 'system',
          action: 'session.purge',
          targetType: 'whatsapp_instances',
          targetId: identity.instanceId,
        });

        await client.query('COMMIT');
        committed = true;
        bumpedSessionEpoch = epochResult.rows[0]?.session_epoch;
      }
    }
  } catch (err) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Best-effort only - the original error still propagates.
      }
    }
    throw err;
  } finally {
    client.release();
  }

  if (staleFence) {
    await deps.selfFence('fence_conflict');
    throw new FenceConflictError(identity.instanceId);
  }

  // P23 Unit U6 (step 7) - the epoch-stranding sweep's hook, ONLY on the
  // real-purge/real-bump branch (never the benign-replay no-op, which did
  // not bump the epoch again). The purge has ALREADY committed by this
  // point - a hook failure must never be allowed to look like a purge
  // failure, so it is caught and logged with ids only, never rethrown.
  if (committed && bumpedSessionEpoch !== undefined) {
    try {
      await deps.onEpochAdvanced?.({
        clientId: identity.clientId,
        instanceId: identity.instanceId,
        sessionEpoch: bumpedSessionEpoch,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      logger.warn(
        { client_id: identity.clientId, instance_id: identity.instanceId },
        `store-purge: onEpochAdvanced hook failed (purge already committed): ${name}`,
      );
    }
  }

  // Redis purge runs unconditionally (both the real-purge and the no-op-
  // replay path) - `purgeInstance`'s DELs are themselves idempotent, so
  // running them again against already-purged/absent keys is always safe.
  await redisRepo.purgeInstance({ clientId: identity.clientId, instanceId: identity.instanceId });

  return { purged: !noOpReplay };
}
