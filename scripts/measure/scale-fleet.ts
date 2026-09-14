import type { HardwareFingerprint } from './artifact.js';

/**
 * scripts/measure/scale-fleet.ts (P26 U2a) - the PURE half of the
 * fleet-scale harness: round-robin instance spread, the plan validator, and
 * the parent<->child IPC message schema + parser. No pg/ioredis/app-backend
 * import here (scripts/ cannot import app/backend - the process-boundary
 * math for a REAL multi-process harness has to live outside the app-backend
 * tree so it stays testable under the root vitest project, same reasoning as
 * `artifact.ts`/`sampler.ts`/`ramp-sessions.ts`). The stateful parent/child
 * halves that actually spawn processes and drive the real lease/fence/
 * EncryptedAuthStore path live in `app/backend/src/engine/measure/
 * scale-fleet*.ts` - the ONE place allowed to import both this module and
 * app-backend (`src-never-imports-scripts-measure` dependency-cruiser rule).
 */

// ---------------------------------------------------------------------
// Round-robin spread.
// ---------------------------------------------------------------------

/**
 * Spreads `instanceIds` across `workerCount` workers round-robin
 * (`instanceIds[0]` -> worker 0, `instanceIds[1]` -> worker 1, ...,
 * wrapping back to worker 0 after `workerCount` ids). Deterministic (pure
 * function of its inputs) and exhaustive (every id appears in exactly one
 * worker's list, order-preserving within each worker). Throws if
 * `workerCount <= 0` - there is no meaningful spread across zero or a
 * negative number of workers.
 */
export function spreadInstances(instanceIds: readonly string[], workerCount: number): string[][] {
  if (workerCount <= 0) {
    throw new Error(`spreadInstances: workerCount must be >= 1, got ${String(workerCount)}`);
  }
  const buckets: string[][] = Array.from({ length: workerCount }, () => []);
  instanceIds.forEach((id, index) => {
    buckets[index % workerCount]?.push(id);
  });
  return buckets;
}

// ---------------------------------------------------------------------
// IPC wait deadlines - derived from the work being waited on, never a bare
// literal at the call site (P26 U2a live-run fix: a real 1,000-instance run
// died on a hardcoded 20_000ms `waitForMessage` timeout because each child
// must build/start ~100 REAL sessions - EncryptedAuthStore load, lease
// acquire, runner start - before it can answer; a fixed deadline that works
// for the 3-instance integration test is structurally wrong at fleet scale).
// ---------------------------------------------------------------------

export interface IpcTimeoutOptions {
  /** Floor for `readyDeadlineMs`, ms. Default 60_000. */
  readyFloorMs?: number;
  /** Per-instance-on-that-worker multiplier for `readyDeadlineMs`, ms. Default 1_000. */
  readyPerInstanceMs?: number;
  /** Floor for `assignDeadlineMs`, ms. Default 120_000. */
  assignMinMs?: number;
  /** Per-instance-in-that-batch multiplier for `assignDeadlineMs`, ms. Default 2_000. */
  assignPerInstanceMs?: number;
  /** Floor for `drainDeadlineMs`, ms. Default 90_000. */
  drainFloorMs?: number;
  /** Per-instance-on-that-worker multiplier for `drainDeadlineMs`, ms. Default 1_000. */
  drainPerInstanceMs?: number;
  /** Fixed deadline for `statsDeadlineMs`, ms. Default 30_000. */
  statsMs?: number;
}

/** Deadline for a child's `ready` reply: it answers before owning any instances, but must first build pools/redis/keyring on a loaded box - scales with how many instances THIS worker will eventually carry. */
export function readyDeadlineMs(instancesPerWorker: number, opts?: IpcTimeoutOptions): number {
  const floor = opts?.readyFloorMs ?? 60_000;
  const perInstance = opts?.readyPerInstanceMs ?? 1_000;
  return Math.max(floor, instancesPerWorker * perInstance);
}

/** Deadline for a batch of `assigned` replies: the acquire + runner-start path per instance dominates and scales linearly with the batch size (never the whole plan - only the instances in THAT assign call). */
export function assignDeadlineMs(batchSize: number, opts?: IpcTimeoutOptions): number {
  const floor = opts?.assignMinMs ?? 120_000;
  const perInstance = opts?.assignPerInstanceMs ?? 2_000;
  return Math.max(floor, batchSize * perInstance);
}

/** Deadline for a child's `drained` reply: the real drain path awaits in-flight sends per session (drain SLO is 45s/worker), so this must sit comfortably above that without hiding a genuine hang. */
export function drainDeadlineMs(instancesPerWorker: number, opts?: IpcTimeoutOptions): number {
  const floor = opts?.drainFloorMs ?? 90_000;
  const perInstance = opts?.drainPerInstanceMs ?? 1_000;
  return Math.max(floor, instancesPerWorker * perInstance);
}

/** Deadline for a `stats` reply - stats-request/reply is O(1) work, so this is a fixed value rather than a derived one. */
export function statsDeadlineMs(opts?: IpcTimeoutOptions): number {
  return opts?.statsMs ?? 30_000;
}

// ---------------------------------------------------------------------
// Plan validation.
// ---------------------------------------------------------------------

export interface ScaleFleetPlan {
  workers: number;
  instancesPerWorker: number;
  tenants: number;
  sessionCap: number;
}

export class InvalidScaleFleetPlanError extends Error {
  constructor(message: string) {
    super(`invalid scale-fleet plan: ${message}`);
    this.name = 'InvalidScaleFleetPlanError';
  }
}

/** Validates a `ScaleFleetPlan` - throws `InvalidScaleFleetPlanError` (message names the offending field) on any violation. */
export function validatePlan(plan: ScaleFleetPlan): void {
  if (plan.workers < 1) {
    throw new InvalidScaleFleetPlanError(`workers must be >= 1, got ${String(plan.workers)}`);
  }
  if (plan.instancesPerWorker < 1) {
    throw new InvalidScaleFleetPlanError(
      `instancesPerWorker must be >= 1, got ${String(plan.instancesPerWorker)}`,
    );
  }
  if (plan.instancesPerWorker > plan.sessionCap) {
    throw new InvalidScaleFleetPlanError(
      `instancesPerWorker (${String(plan.instancesPerWorker)}) must not exceed sessionCap (${String(plan.sessionCap)})`,
    );
  }
}

// ---------------------------------------------------------------------
// Parent<->child IPC message schema.
// ---------------------------------------------------------------------

export interface AssignedInstance {
  instanceId: string;
  clientId: string;
}

export type ParentMessage =
  { type: 'assign'; instances: AssignedInstance[] } | { type: 'drain' } | { type: 'stats-request' };

export type ChildMessage =
  | { type: 'ready'; workerId: string; pid: number }
  | { type: 'assigned'; instanceId: string; acquired: boolean; tookMs: number }
  | {
      type: 'stats';
      workerId: string;
      pid: number;
      rssBytes: number;
      heapUsedBytes: number;
      sessions: number;
      sendsOk: number;
      sendsFailed: number;
      claimIterations: number;
      atMs: number;
      /** Only present when the child installed `installNeverDialGuard` (`WP_SCALE_NEVER_DIAL_GUARD=1`) - the harness never dials real WhatsApp hosts (FakeSock only), so this proves that count rather than enabling any real dial. */
      dialAttempts?: number;
    }
  | { type: 'drained'; exitCode: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parses an unknown IPC payload into a `ParentMessage`, or `null` if it does not match any known shape. Never throws. */
export function parseParentMessage(value: unknown): ParentMessage | null {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    switch (value.type) {
      case 'assign': {
        if (!Array.isArray(value.instances)) return null;
        const instances: AssignedInstance[] = [];
        for (const item of value.instances) {
          if (
            isRecord(item) &&
            typeof item.instanceId === 'string' &&
            typeof item.clientId === 'string'
          ) {
            instances.push({ instanceId: item.instanceId, clientId: item.clientId });
          } else {
            return null;
          }
        }
        return { type: 'assign', instances };
      }
      case 'drain':
        return { type: 'drain' };
      case 'stats-request':
        return { type: 'stats-request' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Parses an unknown IPC payload into a `ChildMessage`, or `null` if it does not match any known shape. Never throws. */
export function parseChildMessage(value: unknown): ChildMessage | null {
  try {
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    switch (value.type) {
      case 'ready':
        if (typeof value.workerId === 'string' && typeof value.pid === 'number') {
          return { type: 'ready', workerId: value.workerId, pid: value.pid };
        }
        return null;
      case 'assigned':
        if (
          typeof value.instanceId === 'string' &&
          typeof value.acquired === 'boolean' &&
          typeof value.tookMs === 'number'
        ) {
          return {
            type: 'assigned',
            instanceId: value.instanceId,
            acquired: value.acquired,
            tookMs: value.tookMs,
          };
        }
        return null;
      case 'stats':
        if (
          typeof value.workerId === 'string' &&
          typeof value.pid === 'number' &&
          typeof value.rssBytes === 'number' &&
          typeof value.heapUsedBytes === 'number' &&
          typeof value.sessions === 'number' &&
          typeof value.sendsOk === 'number' &&
          typeof value.sendsFailed === 'number' &&
          typeof value.claimIterations === 'number' &&
          typeof value.atMs === 'number'
        ) {
          return {
            type: 'stats',
            workerId: value.workerId,
            pid: value.pid,
            rssBytes: value.rssBytes,
            heapUsedBytes: value.heapUsedBytes,
            sessions: value.sessions,
            sendsOk: value.sendsOk,
            sendsFailed: value.sendsFailed,
            claimIterations: value.claimIterations,
            atMs: value.atMs,
            ...(typeof value.dialAttempts === 'number' ? { dialAttempts: value.dialAttempts } : {}),
          };
        }
        return null;
      case 'drained':
        if (typeof value.exitCode === 'number') {
          return { type: 'drained', exitCode: value.exitCode };
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Fleet-run artifact header.
// ---------------------------------------------------------------------

/**
 * The header line the `engine/measure/scale-fleet.ts` parent writes atop
 * its own run artifact - reuses `HardwareFingerprint` (`artifact.ts`) rather
 * than re-deriving a second fingerprint shape. `viaPgBouncer` records
 * whether this run's DB connections went through PgBouncer or direct
 * Postgres (see `resolvePgBouncerDatabaseUrl`'s own doc for when it is
 * `false`/DIRECT-CONNECTION); `pgbouncer` is populated only when `true`.
 */
export interface FleetRunHeader {
  schemaVersion: 1;
  kind: 'scale-fleet';
  capturedAtIso: string;
  workers: number;
  instances: number;
  tenants: number;
  sessionCap: number;
  node: string;
  viaPgBouncer: boolean;
  pgbouncer?: {
    poolMode: 'transaction';
    defaultPoolSize: number;
    maxClientConn: number;
  };
  tunedSysctls: Record<string, string>;
  notes: string[];
  hardware?: HardwareFingerprint;
}

/** Fleet children poll at the PRODUCTION default (`SAFETY_POLL_MS` 30 s). It is also the binding drain cadence today: one claim per trigger, wakes are edge-triggered, and the `next_eligible_at` nudge is not wired (P26 run log #17). */
export const SCALE_FLEET_SAFETY_POLL_MS = 30_000;
