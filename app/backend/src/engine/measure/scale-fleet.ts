import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { createPool } from '@wp/db';
import {
  spreadInstances,
  validatePlan,
  parseChildMessage,
  readyDeadlineMs,
  assignDeadlineMs,
  drainDeadlineMs,
  statsDeadlineMs,
  type ScaleFleetPlan,
  type ChildMessage,
  type IpcTimeoutOptions,
} from '../../../../../scripts/measure/scale-fleet.js';
import { seedScaleFleet, cleanupScaleFleet } from './scale-fleet-seed.js';
import { childExecArgv } from '../../../../../scripts/measure/child-exec-argv.js';
import {
  reassignDeadWorkerInstances as reassignDeadWorkerInstancesImpl,
  type TakeoverResult,
} from './scale-fleet-takeover.js';
import { sendTo, waitForMessage, forwardChildOutput } from './scale-fleet-ipc.js';
import { readOwnerMap } from './scale-fleet-reads.js';
import type { SyntheticFleetHandles } from '../session/synthetic-fleet-support.js';

/**
 * scale-fleet.ts (P26 U2a) - the PARENT orchestrator: spreads N synthetic
 * instances over REAL worker child PROCESSES (`scale-fleet-child.ts`,
 * spawned via `child_process.spawn`), each driving the real lease/fence/
 * EncryptedAuthStore/claim/reserve/dispatch path against real Postgres +
 * Redis, through a FakeSock (never a real Baileys socket, never real
 * network - see `scale-fleet-child.ts`'s own header).
 *
 * TAKEOVER MODEL (documented once, here): this harness proves "parent-
 * observed staleness -> real LeaseManager.acquire + real grace" -
 * `reassignDeadWorkerInstances` polls `instance_lease_state.lease_seen_at`
 * for the dead worker's own instances until the row looks stale (NULL or
 * older than `DISCOVERY_STALE_MS`, `engine/fleet/discovery.ts`'s own
 * predicate), then round-robins a real `assign` to survivors, who acquire
 * through the REAL `LeaseManager`. It does NOT exercise the random discovery
 * SCAN (`runOneScanIteration`, covered by
 * `fleet-recovery-storm.integration.test.ts`): this harness's ownership
 * model is always explicit assignment, never a scan.
 */

export interface CreateScaleFleetOptions {
  handles: SyntheticFleetHandles;
  plan: ScaleFleetPlan;
  childEnv?: Record<string, string>;
  timing?: Record<string, number>;
  /** IPC `waitForMessage` deadlines - see `scripts/measure/scale-fleet.ts`'s `readyDeadlineMs`/`assignDeadlineMs`/`drainDeadlineMs`/`statsDeadlineMs` for the derivation and defaults. Every deadline is derived from the work being waited on (instances per worker, or the actual assign-batch size) - never a bare literal at the call site. */
  ipcTimeouts?: IpcTimeoutOptions;
}

interface ChildHandle {
  workerId: string;
  proc: ChildProcess;
  killedAtMs?: number;
  latestStats?: Extract<ChildMessage, { type: 'stats' }>;
}

export type { TakeoverResult };

export interface ScaleFleet {
  start(): Promise<void>;
  kill9(workerId: string): void;
  drain(workerId: string): Promise<number | undefined>;
  spawn(workerId: string): Promise<void>;
  reassignDeadWorkerInstances(
    deadWorkerId: string,
    toWorkerIds: string[],
  ): Promise<TakeoverResult[]>;
  stats(): Map<string, Extract<ChildMessage, { type: 'stats' }>>;
  /** Sends `stats-request` to every live child and waits for a fresh reply from each - `stats()` afterward reflects THIS call, not whatever the periodic timer last emitted. */
  requestStats(): Promise<Map<string, Extract<ChildMessage, { type: 'stats' }>>>;
  ownerMap(): Promise<Map<string, string>>;
  /** The tenant ids `start()` seeded - every fleet read is `client_id`-scoped to these (invariant 4). */
  clientIds(): string[];
  stop(): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = resolve(HERE, 'scale-fleet-child.ts');
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

export function createScaleFleet(options: CreateScaleFleetOptions): ScaleFleet {
  validatePlan(options.plan);
  const { handles, plan } = options;
  const children = new Map<string, ChildHandle>();
  let clientIds: string[] = [];
  let allInstances: { instanceId: string; clientId: string }[] = [];

  function workerIdFor(index: number): string {
    return `scale-worker-${index}`;
  }

  async function spawnChild(workerId: string): Promise<ChildHandle> {
    // Children load TS the way THIS parent did - rule + run #4 root cause in child-exec-argv.ts.
    const execArgv = childExecArgv({
      parentExecArgv: process.execArgv,
      override: process.env.WP_SCALE_CHILD_EXEC_ARGV,
    });
    const proc = spawn(process.execPath, [...execArgv, CHILD_PATH], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...options.childEnv,
        WP_SCALE_WORKER_ID: workerId,
        WP_SCALE_SESSION_CAP: String(plan.sessionCap),
        WP_SCALE_KEY_RING_PATH: handles.keyRingPath,
        ...(options.timing ? { WP_SCALE_TIMING: JSON.stringify(options.timing) } : {}),
      },
    });
    proc.setMaxListeners(0); // one `assigned` listener per instance in a batch - bounded, not a leak
    forwardChildOutput(proc, workerId); // a silent child is undiagnosable (run log #9)
    const handle: ChildHandle = { workerId, proc };
    proc.on('message', (raw: unknown) => {
      const msg = parseChildMessage(raw);
      if (msg?.type === 'stats') {
        handle.latestStats = msg;
      }
    });
    children.set(workerId, handle);
    await waitForMessage(
      proc,
      (m): m is Extract<ChildMessage, { type: 'ready' }> => m.type === 'ready',
      readyDeadlineMs(plan.instancesPerWorker, options.ipcTimeouts),
      `ready from ${workerId}`,
    );
    return handle;
  }

  return {
    async start(): Promise<void> {
      const spawnedWorkerIds: string[] = [];
      try {
        const seeded = await seedScaleFleet(handles, plan);
        clientIds = seeded.clientIds;
        allInstances = seeded.instances;

        const workerIds = Array.from({ length: plan.workers }, (_, i) => workerIdFor(i));
        for (const workerId of workerIds) {
          await spawnChild(workerId);
          spawnedWorkerIds.push(workerId);
        }

        const instanceIds = allInstances.map((i) => i.instanceId);
        const spread = spreadInstances(instanceIds, plan.workers);
        const byInstanceId = new Map(allInstances.map((i) => [i.instanceId, i]));

        for (let i = 0; i < workerIds.length; i += 1) {
          const workerId = workerIds[i];
          const ids = spread[i] ?? [];
          const handle = workerId ? children.get(workerId) : undefined;
          if (!handle) continue;
          const instances = ids
            .map((id) => byInstanceId.get(id))
            .filter((v): v is { instanceId: string; clientId: string } => v !== undefined);
          // Listeners BEFORE `sendTo`: a child can reply before a post-send
          // `waitForMessage` would start listening (same race as scale-fleet-takeover.ts).
          const deadline = assignDeadlineMs(instances.length, options.ipcTimeouts);
          const waits = instances.map((instance) =>
            waitForMessage(
              handle.proc,
              (m): m is Extract<ChildMessage, { type: 'assigned' }> =>
                m.type === 'assigned' && m.instanceId === instance.instanceId,
              deadline,
              `assigned for ${String(instances.length)} instances on ${workerId}`,
            ),
          );
          sendTo(handle.proc, { type: 'assign', instances });
          await Promise.all(waits);
        }
      } catch (err) {
        // Partial failure: SIGKILL every spawned child, run stop()'s cleanup,
        // rethrow the ORIGINAL error (never swallowed, never masked by cleanup).
        for (const workerId of spawnedWorkerIds) {
          children.get(workerId)?.proc.kill('SIGKILL');
        }
        try {
          await cleanupScaleFleet(handles.pool, clientIds);
        } catch {
          // best-effort - the original error is what matters.
        }
        throw err;
      }
    },

    kill9(workerId: string): void {
      const handle = children.get(workerId);
      if (!handle) return;
      handle.killedAtMs = Date.now();
      handle.proc.kill('SIGKILL');
    },

    async drain(workerId: string): Promise<number | undefined> {
      const handle = children.get(workerId);
      if (!handle) return undefined;
      sendTo(handle.proc, { type: 'drain' });
      const drained = await waitForMessage(
        handle.proc,
        (m): m is Extract<ChildMessage, { type: 'drained' }> => m.type === 'drained',
        drainDeadlineMs(plan.instancesPerWorker, options.ipcTimeouts),
        `drained from ${workerId}`,
      );
      return drained.exitCode;
    },

    async spawn(workerId: string): Promise<void> {
      await spawnChild(workerId);
    },

    async reassignDeadWorkerInstances(
      deadWorkerId: string,
      toWorkerIds: string[],
    ): Promise<TakeoverResult[]> {
      return reassignDeadWorkerInstancesImpl(
        {
          pool: handles.pool,
          allInstances,
          children,
          sendTo,
          waitForMessage,
          ipcTimeouts: options.ipcTimeouts,
        },
        deadWorkerId,
        toWorkerIds,
      );
    },

    stats(): Map<string, Extract<ChildMessage, { type: 'stats' }>> {
      const out = new Map<string, Extract<ChildMessage, { type: 'stats' }>>();
      for (const [workerId, handle] of children) {
        if (handle.latestStats) out.set(workerId, handle.latestStats);
      }
      return out;
    },

    async requestStats(): Promise<Map<string, Extract<ChildMessage, { type: 'stats' }>>> {
      await Promise.all(
        Array.from(children.values()).map(async (handle) => {
          const before = handle.latestStats?.atMs;
          // Listener attached BEFORE `sendTo` - same race as `start()`/
          // `reassignDeadWorkerInstances` (the child can reply before a
          // post-send listener would even be attached).
          const wait = waitForMessage(
            handle.proc,
            (m): m is Extract<ChildMessage, { type: 'stats' }> =>
              m.type === 'stats' && m.atMs !== before,
            statsDeadlineMs(options.ipcTimeouts),
            `stats from ${handle.workerId}`,
          );
          sendTo(handle.proc, { type: 'stats-request' });
          await wait;
        }),
      );
      const out = new Map<string, Extract<ChildMessage, { type: 'stats' }>>();
      for (const [workerId, handle] of children) {
        if (handle.latestStats) out.set(workerId, handle.latestStats);
      }
      return out;
    },

    async ownerMap(): Promise<Map<string, string>> {
      const pool = handles.pool as ReturnType<typeof createPool>;
      return readOwnerMap(
        pool,
        allInstances.map((i) => i.instanceId),
        clientIds,
      );
    },

    clientIds(): string[] {
      return [...clientIds];
    },

    async stop(): Promise<void> {
      // Parallel drains (one deadline, not N), then ALWAYS cleanup (run log #17).
      await Promise.all(
        [...children.values()].map(async (handle) => {
          if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) return;
          try {
            sendTo(handle.proc, { type: 'drain' });
            await waitForMessage(
              handle.proc,
              (m): m is Extract<ChildMessage, { type: 'drained' }> => m.type === 'drained',
              drainDeadlineMs(plan.instancesPerWorker, options.ipcTimeouts),
              `drained from ${handle.workerId}`,
            );
          } catch {
            handle.proc.kill('SIGKILL');
          }
        }),
      );
      await cleanupScaleFleet(handles.pool, clientIds);
    },
  };
}
