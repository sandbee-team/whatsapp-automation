import type { TIMING } from '@wp/domain';
import type { LeaseRedis } from './lease-redis.js';
import { type MintFenceCtx, release as releaseFence } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * lease-manager.types.ts (P06) - types, port interfaces, and defaults for
 * `LeaseManager` (lease-manager.ts), split out to keep lease-manager.ts
 * under the workspace max-lines limit. Re-exported from lease-manager.ts so
 * every existing importer keeps compiling unchanged.
 */

export interface SessionLease {
  instanceId: string;
  clientId: string;
  fence: bigint;
  workerId: string;
  /**
   * P09 fleet-recovery FIX - the real `TIMING.takeoverGraceMs` (or 0 when the
   * previous owner released cleanly and recently) this lease's caller MUST
   * wait, deferred/cancellable, before opening a socket - never awaited
   * INLINE inside `acquire()` itself (see lease-manager.ts's own step 4 doc
   * comment for why: an inline await here would serialize `discovery.ts`'s
   * sequential grab loop, one real 15s wait per row). `LeaseManager.acquire`
   * has already decided the grace duration by the time it returns; the
   * caller (`engine/session/runner.ts`) owns actually waiting it out,
   * composed with its own `pendingOffsetTimer` cancellable-wait discipline.
   */
  graceMs: number;
}

export interface AcquireInput {
  instanceId: string;
  clientId: string;
}

/** Minimal logging surface - callers may pass `console` or any structured logger. */
export interface LeaseLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: LeaseLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Single-transaction tenant executor - production callers pass
 * `TenantDb.withTenant` bound to the real pool; tests pass an equivalent
 * stub. Matches `db/src/tenant-db.ts`'s `TenantDb.withTenant` shape exactly
 * (structural, not a direct import, so this module never depends on `pg`).
 */
export interface TenantTxRunner {
  withTenant<T>(clientId: string, fn: (tx: MintFenceCtx['sql']) => Promise<T>): Promise<T>;
}

/** The two `wp_`-metric increments `LeaseManager` needs - see `platform/metrics/lease-metrics.ts`. */
export interface LeaseManagerMetricsPort {
  incrementTakeovers: () => void;
  incrementFenceRegression: () => void;
}

export const NOOP_METRICS: LeaseManagerMetricsPort = {
  incrementTakeovers: () => undefined,
  incrementFenceRegression: () => undefined,
};

export interface LeaseManagerDeps {
  leaseRedis: LeaseRedis;
  tenantDb: TenantTxRunner;
  sessionOwner: SessionOwner;
  timing?: typeof TIMING;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logger?: LeaseLogger;
  metrics?: LeaseManagerMetricsPort;
  workerId: string;
  env: string;
}

/**
 * Seam for `LeaseManager.release()`'s Postgres step - defaults to the real
 * `lease-state-repo.ts` `release` function; overridable in tests exactly
 * like `sleep`/`now` above (never a hidden import swap).
 */
export interface LeaseManagerReleaseDeps {
  pgRelease?: typeof releaseFence;
}

export const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Grace may be skipped only when the previous release was clean AND recent (within this window). */
export const RELEASE_FRESHNESS_MS = 60_000;
