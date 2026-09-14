import type { Redis } from 'ioredis';
import type { createPool, createTenantDb } from '@wp/db';
import { logger, describeError } from '@wp/server-kit';
import {
  createDrain,
  markNeedsReconcile,
  DEFAULT_DRAIN_DEADLINES,
  type DrainDeps,
} from '../fleet/drain.js';
import { buildDbInFlightPort } from '../fleet/inflight-db-port.js';
import { buildDrainSessions } from './fleet-adapters.js';
import type { SessionWorker } from './session-worker-composition.js';

/**
 * session-worker-drain-wiring.ts (launch-checklist row 31, 2026-09-11) -
 * builds the production `createDrain` deps for `roles/session-worker.ts`,
 * mechanically extracted out of that file for the `max-lines: 300` cap (same
 * idiom as `session-worker-discovery-wiring.ts`). Wires the REAL DB-derived
 * `InFlightPort` (`inflight-db-port.ts#buildDbInFlightPort`, scoped to
 * exactly the instances/clients THIS worker's registry currently holds - the
 * same tenant-scoping every other fleet reader follows, invariant 4) and the
 * REAL `markNeedsReconcile` (`drain.ts`, run through `tenantDb.withTenant` so
 * the write is `app.client_id`-scoped) - replacing the two permanent stubs
 * (`buildEmptyInFlightPort` + a bare no-op) documented in
 * `.memory/lessons/2026-09-11-graceful-drain-abandoned-in-flight-claims-empty-inflight-port-stub.md`.
 * Mirrors `engine/measure/scale-fleet-child.ts#runDrain`'s already-proven
 * wiring so the harness and production role share one contract.
 */

export interface SessionWorkerDrainWiringDeps {
  worker: SessionWorker;
  pool: ReturnType<typeof createPool>;
  tenantDb: ReturnType<typeof createTenantDb>;
  redisCtl: Redis;
  redisSig: Redis;
  redisCache: Redis;
  stopClaiming: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Builds one `createDrain(...)` instance. Snapshots the owned instance/client
 * ids from the live registry BEFORE any teardown runs (mirrors the harness
 * child's own ordering note): `worker.registry` only holds an entry per
 * instance while this process still owns its socket.
 */
export function buildSessionWorkerDrain(deps: SessionWorkerDrainWiringDeps): {
  run(): Promise<void>;
} {
  const ownedPairs = [...deps.worker.registry.values()].map((h) => ({
    instanceId: h.instanceId,
    clientId: h.clientId,
  }));

  const drainDeps: DrainDeps = {
    beginDrain: () => deps.worker.beginDrain(),
    stopClaiming: deps.stopClaiming,
    inFlight: buildDbInFlightPort(deps.tenantDb, ownedPairs),
    markNeedsReconcile: (job) =>
      deps.tenantDb.withTenant(job.clientId, (tx) => markNeedsReconcile(tx, job)),
    sessions: buildDrainSessions(
      deps.worker.registry,
      deps.worker.leaseManager,
      (instanceId) => deps.worker.getHeldLease(instanceId),
      // Deliberate no-op: saveCreds already writes durably (no flush primitive in EncryptedAuthStore).
      async () => undefined,
    ),
    closePools: async () => {
      await deps.redisCtl.quit();
      await deps.redisSig.quit();
      await deps.redisCache.quit();
      await deps.pool.end();
    },
    exit: deps.exit,
    deadlines: DEFAULT_DRAIN_DEADLINES,
    logger: {
      // C1 FINDING 7: a `meta.err` value can be a raw pg error, which
      // routinely carries statement parameters in `detail`/`hint`/etc
      // (see `describeError`'s own doc). Summarize `err` through that
      // helper - name+code only - BEFORE the object ever reaches
      // JSON.stringify; jobId/instanceId (never sensitive) pass through
      // unchanged.
      error: (message, meta) => {
        if (!meta) {
          logger.error({}, message);
          return;
        }
        const { err, ...rest } = meta;
        const safeMeta = err === undefined ? rest : { ...rest, err: describeError(err) };
        logger.error({}, `${message} ${JSON.stringify(safeMeta)}`);
      },
    },
  };

  return createDrain(drainDeps);
}
