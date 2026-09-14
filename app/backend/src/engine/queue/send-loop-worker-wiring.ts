import type { Redis } from 'ioredis';
import type { createPool, TenantDb } from '@wp/db';
import type { Rng } from '@wp/domain';
import { logger, describeError } from '@wp/server-kit';
import { dispatch, type DispatchDeps } from './dispatch.js';
import { resolveAck, resolveFailure, type ResultDeps } from './result.js';
import type { QueueMetricsHandles } from './metrics.js';
import { createWakeSubscriber, safetyPollIntervalMs } from './wake.js';
import { runOneSendLoopIteration } from './send-loop.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';
import { bindPacingMetrics } from '../pacing/metrics.js';
import { bindWalletMetrics } from '../../platform/metrics/wallet-metrics.js';
import {
  createSendLoopFleetWiring,
  type FleetRegistryHandle,
  type SendLoopFleetWiring,
  type SendLoopFleetWiringDeps,
  type StoppablePort,
} from './send-loop-fleet-wiring.js';
import type { ClaimOneCtx, ClaimOneInput, ClaimedJob } from '../../modules/queue/queue.repo.js';
import { createBaileysMessageTransport } from '../../provider/baileys/adapter.js';
import type { BaileysSendSocketPort } from '../../provider/baileys/adapter.js';
import type { MessageTransport } from '../../provider/provider.types.js';
import { onSendOutcome } from '../../modules/pacing/health/fast-lane.js';
import type { FastLaneCtx } from '../../modules/pacing/health/fast-lane.js';

/**
 * send-loop-worker-wiring.ts (P11 Unit U5, step 9; P13 pacing wiring) -
 * assembles a real `SendLoopFleetWiringDeps` (`send-loop-fleet-wiring.ts`)
 * from the handles `roles/session-worker.ts` already has at boot (pool,
 * `tenantDb`, `redisCtl`, `config.SAFETY_POLL_MS`) - kept OUT of `roles/
 * session-worker.ts` itself purely for the max-lines cap (that file is at
 * 300/300 before this unit; see `session-worker-discovery-wiring.ts` for
 * the same established split idiom).
 *
 * PACING (P13): the interim in-memory `InterimGapGate` this header used to
 * describe has been RETIRED and DELETED (`engine/queue/interim-gap.ts`).
 * `deps.claimOne` is now built via `send-loop-pacing-claim.ts#
 * claimAndReserve`, which combines the claim AND the real durable pacing
 * reserve inside ONE `tenantDb.withTenant` transaction - see that file's
 * own doc for the full claim/reserve/deny-write contract.
 *
 * P12 U0 closes the gap this header used to document: `transport` now
 * defaults to `createBaileysMessageTransport({ getSendSocket })`, where
 * `getSendSocket` looks the instance up in the live `SessionRunnerRegistry`
 * and returns `handle?.getSendSocket?.()`. That accessor
 * (`engine/session/registry.ts`'s `RunnerHandle.getSendSocket`) is a
 * SEPARATE, narrower port from `getSock` - it never exposes `.logout()` or
 * the raw socket, and only returns a send-capable object once the runner
 * has actually observed the connection open (see that file's own doc
 * comment). An instance absent from the registry, or one whose connection
 * has not opened yet, still fails closed as `not_connected` -> RETRY_
 * BACKOFF - never a silent success. `transport` stays caller-overridable
 * for tests exactly as before.
 */

export interface SendLoopWorkerWiringDeps {
  env: string;
  workerId: string;
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  /** The control-plane Redis handle (`redis-ctl`) - `.duplicate()` is called once per started subscriber, mirroring `modules/realtime/redis-bridge.ts`'s own subscriber pattern (a dedicated connection per subscription; ioredis requires a separate client once `.subscribe()` is called). */
  redisCtl: Pick<Redis, 'publish'> & { duplicate(): Redis };
  /** Defaults to the real `modules/queue/queue.repo.js#claimOne` - overridable for tests. */
  claimOne?: (ctx: ClaimOneCtx, input: ClaimOneInput) => Promise<ClaimedJob | undefined>;
  /** Defaults to `createBaileysMessageTransport({ getSendSocket })`, where `getSendSocket` calls `resolveSendSocket` (below) - overridable for tests. */
  transport?: MessageTransport;
  /**
   * Resolves the live send-capable socket for `instanceId`, or `undefined`
   * if none is safely sendable right now - `bootSendLoopFleetWiring` builds
   * this from `worker.registry` in production
   * (`handle?.getSendSocket?.()`). Optional so `buildSendLoopWorkerWiring`
   * stays directly testable without a registry; omitting it (and `transport`)
   * makes every instance fail closed as `not_connected`, matching the
   * pre-P12-U0 default.
   */
  resolveSendSocket?: (instanceId: string) => BaileysSendSocketPort | undefined;
  metrics: QueueMetricsHandles;
  /** `config.SAFETY_POLL_MS` - already fail-closed-validated at config load (`platform/config.ts`'s own `.max(60_000)`); `safetyPollIntervalMs` re-validates as defence in depth (see that function's own doc). */
  safetyPollMs: number;
  rng: Rng;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /**
   * P16 Unit C - the fast-lane hook: called after EVERY failed send
   * resolution with the outcome's `SendErrorClass`, in its OWN
   * `tenantDb.withTenant` transaction (never the same transaction as
   * `resolveFailure`'s two, which have already committed by the time this
   * runs - see `fast-lane.ts`'s own doc for why an override-shaped decision
   * does not need to share a transaction with the job-outcome write).
   * Defaults to the real `onSendOutcome` - overridable for tests, omit-safe
   * (a throw here is caught and logged, never allowed to fail the send loop
   * itself - fail-safe means a fast-lane hiccup never blocks sends).
   */
  onSendOutcome?: (clientId: string, instanceId: string, errorClass: string) => Promise<void>;
}

/** Builds the real (non-overridden) fast-lane onSendOutcome callback, bound to `tenantDb`. */
function buildFastLaneOnSendOutcome(
  tenantDb: TenantDb,
): (clientId: string, instanceId: string, errorClass: string) => Promise<void> {
  return async (clientId, instanceId, errorClass) => {
    try {
      await tenantDb.withTenant(clientId, async (tx) => {
        const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => Date.now() } };
        await onSendOutcome(ctx, { instanceId, errorClass });
      });
    } catch (err) {
      logger.error(
        {},
        `fast-lane onSendOutcome failed (instance ${instanceId}): ${describeError(err)}`,
      );
    }
  };
}

/**
 * `message_jobs` is RLS-`FORCE`d (migration 0007) - reads MUST run inside a
 * `tenantDb.withTenant` transaction, which sets `app.client_id` before this
 * query runs. A raw `pool.query()` here would silently see zero rows under
 * `wp_scheduler` (the production role, not a RLS-bypassing superuser) - the
 * exact hazard `queue.repo.ts`'s own module doc documents for `claimOne`.
 */
async function readMaxAttempts(
  tenantDb: TenantDb,
  clientId: string,
  jobId: string,
): Promise<number> {
  return tenantDb.withTenant(clientId, async (tx) => {
    const result = await tx.query<{ max_attempts: number }>(
      'SELECT max_attempts FROM message_jobs WHERE id = $1 AND client_id = $2',
      [jobId, clientId],
    );
    return result.rows[0]?.max_attempts ?? 5;
  });
}

/**
 * Everything `SendLoopFleetWiringDeps` needs EXCEPT `registry`/
 * `getHeldLease` - those two come straight from the live `SessionWorker`
 * (`worker.registry`/`worker.getHeldLease`), which only exists once
 * `createSessionWorker` has already run in `roles/session-worker.ts`; this
 * function has no dependency on that composition and stays testable
 * without it.
 */
export type SendLoopWorkerWiring = Omit<SendLoopFleetWiringDeps, 'registry' | 'getHeldLease'>;

/** Builds the real send-loop production wiring, minus `registry`/`getHeldLease` (see `SendLoopWorkerWiring`'s own doc). */
export function buildSendLoopWorkerWiring(deps: SendLoopWorkerWiringDeps): SendLoopWorkerWiring {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const resolveSendSocket = deps.resolveSendSocket ?? (() => undefined);
  const transport =
    deps.transport ?? createBaileysMessageTransport({ getSendSocket: resolveSendSocket });
  const pacingMetrics = bindPacingMetrics();
  // `message_jobs` is RLS-FORCEd (migration 0007): every claim+reserve
  // attempt MUST run inside a tenantDb.withTenant transaction, which sets
  // `app.client_id` before either query runs - a raw pool handed in as
  // `ctx.sql` would silently claim zero rows forever under `wp_scheduler`
  // (see queue.repo.ts's own module doc). One transaction PER CLAIM
  // ATTEMPT (never held open across loop iterations, never shared across
  // the whole DWRR band fall-through) is the correct granularity here
  // (delta row 8: worker pool max 4 + PgBouncer transaction mode).
  const claimOneUnderTenant = claimAndReserve({
    tenantDb: deps.tenantDb,
    rng: deps.rng,
    clock: { now: () => Date.now() },
    claimOne: deps.claimOne,
    onPacingDeny: (reason) => pacingMetrics.deferralsTotal.inc({ reason }),
    onGuardTrip: (reason) => {
      deps.metrics.contentGuardTripsTotal.inc({ reason });
      if (reason === 'OPT_OUT') {
        deps.metrics.optoutCancelledJobsTotal.inc();
      }
    },
  });

  const fastLaneOnSendOutcome = deps.onSendOutcome ?? buildFastLaneOnSendOutcome(deps.tenantDb);

  return {
    workerId: deps.workerId,
    metrics: deps.metrics,
    logger: { error: (msg, meta) => logger.error(meta ?? {}, msg) },

    runOneIteration: async (clientId, instanceId, fence, dwrr) => {
      return runOneSendLoopIteration({
        clientId,
        instanceId,
        workerId: deps.workerId,
        fence,
        claimOne: claimOneUnderTenant,
        dispatch: (input, dispatchDeps) => dispatch(input, dispatchDeps as DispatchDeps),
        resolveAck: (input, resultDeps) => resolveAck(input, resultDeps as ResultDeps),
        resolveFailure: async (input, resultDeps) => {
          await resolveFailure(input, resultDeps);
          // P16 Unit C fast-lane hook - fires AFTER resolveFailure's own
          // writes have committed (module doc); a hook failure is caught
          // inside buildFastLaneOnSendOutcome and never rethrown here.
          await fastLaneOnSendOutcome(clientId, instanceId, input.error.class);
        },
        readMaxAttempts: (jobId) => readMaxAttempts(deps.tenantDb, clientId, jobId),
        metrics: deps.metrics,
        rng: deps.rng,
        clock: { now: () => Date.now() },
        dwrr,
        // No `ctx` supplied: `claimOneUnderTenant` above ignores whatever
        // `sql` a caller-supplied ctx would carry anyway (it always opens
        // its own `tenantDb.withTenant` transaction), so `send-loop.ts`'s
        // own `{clientId, sql: undefined}` fallback ctx is exactly as
        // correct here as anything this wiring could construct - no `as
        // never` cast needed on either side.
        dispatchDeps: {
          tenantDb: deps.tenantDb,
          transport,
          clock: { now: () => Date.now() },
        },
        resultDeps: {
          tenantDb: deps.tenantDb,
          rng: deps.rng,
          walletMetrics: bindWalletMetrics(),
        },
      });
    },

    startSubscriber: async (clientId, instanceId, onTrigger) => {
      const subscriberRedis = deps.redisCtl.duplicate();
      const subscriber = createWakeSubscriber({
        redis: subscriberRedis,
        env: deps.env,
        clientId,
        instanceId,
        onWake: onTrigger,
        metrics: { incrementWakeReceived: () => deps.metrics.wakeReceivedTotal.inc() },
      });
      await subscriber.start();
      return {
        stop: async () => {
          await subscriber.stop();
          subscriberRedis.disconnect();
        },
      };
    },

    startSafetyPollTimer: (_clientId, _instanceId, onTrigger): StoppablePort => {
      const intervalMs = Math.round(safetyPollIntervalMs(deps.safetyPollMs, deps.rng));
      const handle = setIntervalFn(onTrigger, intervalMs);
      return {
        stop: () => {
          clearIntervalFn(handle);
        },
      };
    },
  };
}

/** The narrow slice of `SessionWorker` (`session-worker-composition.ts`) `bootSendLoopFleetWiring` needs - avoids importing that module's own type here purely to keep this file's dependency direction one-way (queue engine never imports FROM `engine/session/**`). */
export interface SendLoopWorkerHost {
  registry: ReadonlyMap<string, FleetRegistryHandle>;
  getHeldLease(instanceId: string): { fence: bigint } | undefined;
}

/**
 * Composes `buildSendLoopWorkerWiring` + `createSendLoopFleetWiring` in one
 * call - the single line `roles/session-worker.ts` needs (split out purely
 * for that file's own max-lines cap, same reasoning as this file's own
 * header comment).
 */
export function bootSendLoopFleetWiring(
  deps: SendLoopWorkerWiringDeps,
  worker: SendLoopWorkerHost,
): SendLoopFleetWiring {
  const resolveSendSocket =
    deps.resolveSendSocket ??
    ((instanceId: string): BaileysSendSocketPort | undefined =>
      worker.registry.get(instanceId)?.getSendSocket?.());
  return createSendLoopFleetWiring({
    ...buildSendLoopWorkerWiring({ ...deps, resolveSendSocket }),
    registry: worker.registry,
    getHeldLease: (instanceId) => worker.getHeldLease(instanceId),
  });
}
