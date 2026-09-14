import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { TIMING as DEFAULT_TIMING } from '@wp/domain';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl, resolvePgBouncerDatabaseUrl } from '../../platform/db/db-url.js';
import { createSessionWorker } from '../session/session-worker-composition.js';
import { createCountingSocketFactory } from '../session/synthetic-fleet-support.js';
import { createDrain, DEFAULT_DRAIN_DEADLINES, markNeedsReconcile } from '../fleet/drain.js';
import { buildDrainSessions } from '../session/fleet-adapters.js';
import { buildDbInFlightPort } from '../fleet/inflight-db-port.js';
import { bootSendLoopFleetWiring } from '../queue/send-loop-worker-wiring.js';
import { bindQueueMetrics } from '../queue/metrics.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { installNeverDialGuard } from './scale-fleet-never-dial.js';
import {
  parseParentMessage,
  SCALE_FLEET_SAFETY_POLL_MS,
} from '../../../../../scripts/measure/scale-fleet.js';

/**
 * scale-fleet-child.ts (P26 U2a) - ONE fleet-scale worker PROCESS entry.
 * Mirrors `roles/session-worker.ts`'s real composition (a real
 * `createSessionWorker` + `bootSendLoopFleetWiring`) but wired with a
 * `createCountingSocketFactory` (FakeSock, zero network - never Baileys)
 * and `createFakeTransport({ mode: 'real-latency' })` for sends (the
 * FakeSock has no `sendMessage`, so the fake transport is supplied
 * DIRECTLY, bypassing `resolveSendSocket`/`getSendSocket` entirely - sends
 * flow unconditionally, never gated on registry socket state).
 *
 * Ownership is EXPLICIT ONLY: instances are assigned by the parent
 * (`assign` IPC message) and acquired via `startDiscoveredForTest` - this
 * child never runs the random discovery SCAN (`runOneScanIteration`), which
 * would fan out into the shared dev DB's unrelated rows (same rationale as
 * `fleet-recovery-test-support.ts`). Takeover of a dead worker's instances
 * is PARENT-DRIVEN (`scale-fleet.ts#reassignDeadWorkerInstances`), never
 * something this child polls for on its own.
 *
 * On `drain`/SIGTERM: runs the REAL drain path (`createDrain` +
 * `buildDrainSessions`/`buildDbInFlightPort`), replies `drained`, exits. The
 * in-flight port is DB-derived (`engine/fleet/inflight-db-port.ts`), not the
 * always-empty stub - a claimed job whose ack races this worker's own drain
 * is marked `needs_reconcile` here rather than left silently `processing`
 * until the reaper's lease-expiry sweep (claimExpiryMs + graceSeconds later)
 * catches it (debugger session 2026-09-11, `rolling-deploy.integration.
 * test.ts`'s `accounted !== jobIds.length` under six-file contention).
 * A SIGKILL gets no chance to run any of this - that is the point (see
 * `synthetic-fleet-support.ts#kill9`'s own doc for the same semantics).
 */

const workerId = process.env.WP_SCALE_WORKER_ID ?? `scale-worker-${String(process.pid)}`;
const sessionCap = Number(process.env.WP_SCALE_SESSION_CAP ?? '100');
const statsIntervalMs = Number(process.env.WP_SCALE_STATS_MS ?? '5000');
const timing = process.env.WP_SCALE_TIMING
  ? {
      ...DEFAULT_TIMING,
      ...(JSON.parse(process.env.WP_SCALE_TIMING) as Partial<typeof DEFAULT_TIMING>),
    }
  : DEFAULT_TIMING;

const neverDialGuard =
  process.env.WP_SCALE_NEVER_DIAL_GUARD === '1' ? installNeverDialGuard() : undefined;

let sendsOk = 0;
let sendsFailed = 0;
let claimIterations = 0;

function send(message: unknown): void {
  process.send?.(message);
}

async function main(): Promise<void> {
  // Deployed topology (design §3.6, scope delta "what breaks first" #8): a
  // worker talks to Postgres THROUGH PgBouncer (transaction mode) with a pool
  // of at most 4. Ten direct-pool children + PgBouncer's own 60 server
  // connections blew the server's max_connections=100 at N=1,000 (P26 run
  // log #18: "sorry, too many clients already"). Falls back to a direct
  // connection only when no PgBouncer is configured - and then the run's
  // artifact must say DIRECT-CONNECTION.
  const pool = createPool({
    connectionString: resolvePgBouncerDatabaseUrl() ?? resolveDatabaseUrl(),
    max: 4,
    applicationName: `scale-fleet-child-${workerId}`,
  });
  const redisCtl = createRedis(resolveRedisUrl());
  const redisSig = createRedis(resolveRedisUrl());
  const redisCache = createRedis(resolveRedisUrl());
  const keyRingPath = process.env.WP_SCALE_KEY_RING_PATH;
  if (!keyRingPath) {
    throw new Error('scale-fleet-child: WP_SCALE_KEY_RING_PATH is required');
  }

  const counting = createCountingSocketFactory({ openAfterMs: 5 });
  const transport = createFakeTransport();
  const originalSend = transport.send.bind(transport);
  transport.send = async (instanceId, msg) => {
    // A real transport returns a UNIQUE provider message id per send; the
    // fake's DEFAULT_OUTCOME returns 'default-msg-id' for every call, which
    // collides on message_wa_ids' PK from the second send per instance (P26
    // run log #8). Queue a unique id with a small REAL latency per call.
    transport.queueResolve(
      20 + Math.floor(Math.random() * 20),
      `fake-${globalThis.crypto.randomUUID()}`,
      'real-latency',
    );
    try {
      const outcome = await originalSend(instanceId, msg);
      sendsOk += 1;
      return outcome;
    } catch (err) {
      sendsFailed += 1;
      throw err;
    }
  };

  const worker = createSessionWorker({
    env: 'test',
    workerId,
    pool,
    tenantDb: createTenantDb(pool),
    workerDb: createWorkerDb(pool),
    redisCtl,
    redisSig,
    redisCache,
    keyProvider: new FileKeyProvider({ ringPath: keyRingPath, mountedPurposes: ['session'] }),
    socketFactory: counting.factory,
    sessionCap,
    timing,
  });

  const queueMetrics = bindQueueMetrics();
  const assignedIds: string[] = [];
  const sendLoopWiring = bootSendLoopFleetWiring(
    {
      env: 'test',
      workerId,
      pool,
      tenantDb: createTenantDb(pool),
      redisCtl,
      metrics: queueMetrics,
      safetyPollMs: SCALE_FLEET_SAFETY_POLL_MS, // production default, see scripts/measure/scale-fleet.ts
      rng: { random: () => Math.random() },
      transport,
    },
    worker,
  );

  // Production reconciles the send loops on EVERY discovery tick
  // (roles/session-worker.ts). A one-shot reconcile after `assign` is not
  // enough: `startDiscoveredForTest` resolves as soon as the lease is acquired,
  // but the runner only enters the registry after its deferred takeover grace
  // + socket `open` (real TIMING: 15 s) - so a reconcile run right after the
  // batch sees an EMPTY registry and starts nothing (P26 run log #11: every
  // fleet-scale run before 14:45 IST 2026-09-07 claimed zero jobs). Mirror
  // production's cadence instead.
  const reconcileTimer = setInterval(
    () => {
      void sendLoopWiring.reconcile().catch((err: unknown) => {
        process.stderr.write(`[${workerId}] reconcile failed: ${String(err)}\n`);
      });
    },
    Number(process.env.WP_SCALE_RECONCILE_MS ?? '5000'),
  );
  reconcileTimer.unref?.();

  async function assignOne(input: { instanceId: string; clientId: string }): Promise<void> {
    const startedAt = Date.now();
    const acquired = await worker.startDiscoveredForTest(input.instanceId, input.clientId);
    if (acquired) assignedIds.push(input.instanceId);
    claimIterations += 1;
    send({
      type: 'assigned',
      instanceId: input.instanceId,
      acquired,
      tookMs: Date.now() - startedAt,
    });
  }

  function emitStats(): void {
    send({
      type: 'stats',
      workerId,
      pid: process.pid,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      sessions: worker.registrySize(),
      sendsOk,
      sendsFailed,
      claimIterations,
      atMs: Date.now(),
      ...(neverDialGuard ? { dialAttempts: neverDialGuard.dialAttempts() } : {}),
    });
  }

  // WP_SCALE_DEBUG=1: one stderr line per stats tick with the loop's own
  // counters - the only way to see, from outside, whether send loops exist
  // (`registry`), whether the lease is provable (`held`), and whether the
  // safety poll / wake ever TRIGGERED an iteration (run log #12-13: zero
  // claim statements ever executed, with the children otherwise silent).
  async function debugLine(): Promise<void> {
    if (process.env.WP_SCALE_DEBUG !== '1') return;
    const read = async (c: { get(): Promise<{ values: { value: number }[] }> }): Promise<number> =>
      (await c.get()).values.reduce((s, v) => s + v.value, 0);
    const held = assignedIds.filter((id) => worker.getHeldLease(id) !== undefined).length;
    process.stderr.write(
      `[${workerId}] debug registry=${String(worker.registrySize())} assigned=${String(assignedIds.length)} held=${String(held)} ` +
        `polls=${String(await read(queueMetrics.safetyPollClaimsTotal))} wakes=${String(await read(queueMetrics.wakeReceivedTotal))} ` +
        `iterErrors=${String(await read(queueMetrics.sendLoopIterationErrorsTotal))} sendsOk=${String(sendsOk)} sendsFailed=${String(sendsFailed)}\n`,
    );
  }
  const statsTimer = setInterval(() => {
    emitStats();
    void debugLine();
  }, statsIntervalMs);
  statsTimer.unref?.();

  let draining = false;
  async function runDrain(): Promise<void> {
    if (draining) return;
    draining = true;
    clearInterval(statsTimer);
    clearInterval(reconcileTimer);
    let exitCode: number | undefined;
    // Snapshot BEFORE any teardown below - `worker.registry` only holds an
    // entry per instance while this process still owns its socket (see
    // registry.ts's own header), so this must run before `beginDrain`'s
    // downstream teardown starts clearing entries.
    const ownedPairs = [...worker.registry.values()].map((h) => ({
      instanceId: h.instanceId,
      clientId: h.clientId,
    }));
    const tenantDb = createTenantDb(pool);
    const drain = createDrain({
      beginDrain: () => worker.beginDrain(),
      stopClaiming: () => sendLoopWiring.shutdown(),
      inFlight: buildDbInFlightPort(tenantDb, ownedPairs),
      markNeedsReconcile: (job) =>
        tenantDb.withTenant(job.clientId, (tx) => markNeedsReconcile(tx, job)),
      sessions: buildDrainSessions(
        worker.registry,
        worker.leaseManager,
        (instanceId) => worker.getHeldLease(instanceId),
        async () => undefined,
      ),
      closePools: async () => {
        await redisCtl.quit();
        await redisSig.quit();
        await redisCache.quit();
        await pool.end();
      },
      exit: (code) => {
        exitCode = code;
      },
      deadlines: DEFAULT_DRAIN_DEADLINES,
    });
    await drain.run();
    neverDialGuard?.uninstall();
    send({ type: 'drained', exitCode: exitCode ?? 0 });
    process.exit(exitCode ?? 0);
  }

  process.on('message', (raw: unknown) => {
    const msg = parseParentMessage(raw);
    if (!msg) return;
    if (msg.type === 'assign') {
      // After the batch is held, start the send loops for it: `reconcile()`
      // is the ONLY path that calls `startOne` (wake subscriber + safety poll
      // per instance) - production runs it after every discovery tick
      // (roles/session-worker.ts). Without it no worker ever claims a job;
      // every fleet-scale run before 2026-09-07 14:00 IST had this gap (P26
      // run log #7). Once per batch, never per instance (reconcile is a
      // registry-wide diff, not a per-instance start).
      void Promise.all(msg.instances.map((i) => assignOne(i)))
        .then(() => sendLoopWiring.reconcile())
        .catch((err: unknown) => {
          process.stderr.write(`[${workerId}] assign/reconcile failed: ${String(err)}\n`);
        });
    } else if (msg.type === 'drain') {
      void runDrain();
    } else if (msg.type === 'stats-request') {
      emitStats();
    }
  });

  process.on('SIGTERM', () => {
    void runDrain();
  });

  send({ type: 'ready', workerId, pid: process.pid });
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  void main();
}
