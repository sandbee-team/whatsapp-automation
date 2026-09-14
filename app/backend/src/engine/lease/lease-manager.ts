import { TIMING } from '@wp/domain';
import { tenantKey } from '../../platform/redis/keys.js';
import type { LeaseRedis } from './lease-redis.js';
import { mintFence, release as releaseFence, type ReleaseInput } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';
import {
  NOOP_LOGGER,
  NOOP_METRICS,
  RELEASE_FRESHNESS_MS,
  type AcquireInput,
  type LeaseLogger,
  type LeaseManagerDeps,
  type LeaseManagerMetricsPort,
  type LeaseManagerReleaseDeps,
  type SessionLease,
  type TenantTxRunner,
} from './lease-manager.types.js';

/**
 * lease-manager.ts (P06 Unit U4, extended U5) - `LeaseManager.acquire()`:
 * the FIXED five-step order that turns "nobody holds this instance's
 * session yet" into a `SessionLease`, or safely gives up. No socket is EVER
 * opened here - that is P08's job, strictly after a `SessionLease` exists.
 *
 * U5 adds `LeaseManager.release()` (the graceful, voluntary counterpart to
 * heartbeat.ts's self-fence path) and wires two metrics into `acquire()`:
 * `wp_lease_takeovers_total` (a mint replaced a DIFFERENT previous owner -
 * never a first-ever mint, never a worker re-minting its own still-held
 * lease) and `wp_fence_regression_total` (a canary: a minted fence that is
 * not strictly greater than the last fence THIS PROCESS saw for that
 * instance - should never fire, since Postgres mints monotonically).
 *
 * Types, port interfaces, and defaults live in `lease-manager.types.ts` and
 * are re-exported below so every existing importer keeps compiling
 * unchanged.
 */

export type {
  AcquireInput,
  LeaseLogger,
  LeaseManagerDeps,
  LeaseManagerMetricsPort,
  LeaseManagerReleaseDeps,
  SessionLease,
  TenantTxRunner,
};

export class LeaseManager {
  private readonly leaseRedis: LeaseRedis;
  private readonly tenantDb: TenantTxRunner;
  private readonly sessionOwner: SessionOwner;
  private readonly timing: typeof TIMING;
  private readonly now: () => Date;
  private readonly logger: LeaseLogger;
  private readonly metrics: LeaseManagerMetricsPort;
  private readonly workerId: string;
  private readonly env: string;
  private readonly pgRelease: typeof releaseFence;

  /**
   * Last fence THIS PROCESS observed minted for each instance -
   * `wp_fence_regression_total`'s canary baseline. Process-local by design
   * (a fresh process has no baseline yet, so its first mint for an instance
   * can never regress against a prior process's fences - the check is
   * "did MY OWN view of monotonicity ever go backwards", not a global
   * cross-process assertion).
   */
  private readonly lastSeenFence = new Map<string, bigint>();

  constructor(deps: LeaseManagerDeps, releaseDeps: LeaseManagerReleaseDeps = {}) {
    this.leaseRedis = deps.leaseRedis;
    this.tenantDb = deps.tenantDb;
    this.sessionOwner = deps.sessionOwner;
    this.timing = deps.timing ?? TIMING;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.workerId = deps.workerId;
    this.env = deps.env;
    this.pgRelease = releaseDeps.pgRelease ?? releaseFence;
  }

  private leaseKey(clientId: string, instanceId: string): string {
    return tenantKey(this.env, clientId, 'lease', 'i', instanceId);
  }

  /**
   * Acquires the session lease for `(input.clientId, input.instanceId)` in
   * this FIXED order - never reordered, never short-circuited:
   *
   *   1. `acquire.lua` NX placeholder - 0 means someone else already holds
   *      the key; return null immediately, no Postgres touched.
   *   2. Mint a fence in Postgres (tenant-scoped, single transaction). A
   *      THROW here means unclear state (core invariant 2): best-effort
   *      compare-delete our own placeholder, then return null - never
   *      proceed as if we owned anything.
   *   3. `set-fence.lua` CAS onto the placeholder. 0 means we no longer
   *      hold the key (raced away/expired) - release NOTHING (we have
   *      nothing left to release) and return null.
   *   4. Grace: skipped ONLY when `prevReleasedAt` is a clean, recent
   *      (< 60s) release; otherwise the caller must wait the full
   *      `takeoverGraceMs` so a not-yet-self-fenced previous owner has a
   *      chance to notice first - `acquire()` itself never awaits this: it
   *      computes the duration and returns it as `SessionLease.graceMs` (P09
   *      fleet-recovery FIX). Blocking here would serialize
   *      `discovery.ts`'s sequential grab loop behind one real 15s wait per
   *      row - the blueprint's per-instance grace was never meant to gate
   *      OTHER instances' acquisitions, only this instance's own socket
   *      open. The heartbeat (added by the caller immediately after
   *      `acquire()` returns) keeps renewing the lease while the caller
   *      waits out `graceMs` before opening a socket.
   *   5. Return the `SessionLease` (with `graceMs` set). No socket is
   *      opened here, ever.
   */
  async acquire(input: AcquireInput): Promise<SessionLease | null> {
    const { instanceId, clientId } = input;
    const key = this.leaseKey(clientId, instanceId);

    // Step 1: NX placeholder.
    const acquired = await this.leaseRedis.acquire(key, this.workerId, this.timing.leaseTtlMs);
    if (!acquired) {
      this.logger.info('lease acquire: NX placeholder held by another worker', { instanceId });
      return null;
    }

    // Step 2: mint the fence in Postgres.
    let fence: bigint;
    let prevReleasedAt: Date | null;
    let prevOwnerWorkerId: string | null;
    try {
      const result = await this.tenantDb.withTenant(clientId, (sql) =>
        mintFence({ clientId, sql }, { instanceId, workerId: this.workerId }),
      );
      fence = result.fence;
      prevReleasedAt = result.prevReleasedAt;
      prevOwnerWorkerId = result.prevOwnerWorkerId;
    } catch (err) {
      this.logger.error(
        'lease acquire: mintFence threw, unclear state - self-releasing placeholder',
        {
          instanceId,
          err,
        },
      );
      try {
        await this.leaseRedis.release(key, `${this.workerId}|PENDING`);
      } catch (releaseErr) {
        // Best-effort only: the placeholder will still expire via its own
        // TTL. Never let a failed cleanup mask the original mint failure.
        this.logger.warn('lease acquire: best-effort placeholder release also failed', {
          instanceId,
          releaseErr,
        });
      }
      return null;
    }

    // Step 3: CAS the minted fence onto the placeholder.
    const fenceSet = await this.leaseRedis.setFence(
      key,
      this.workerId,
      fence,
      this.timing.leaseTtlMs,
    );
    if (!fenceSet) {
      // We no longer hold the key - nothing left of ours to release.
      this.logger.warn('lease acquire: set-fence CAS lost the placeholder, aborting', {
        instanceId,
      });
      return null;
    }

    // Step 4: grace period duration, unless the previous owner released
    // cleanly and recently. `delta` must be signed and checked on BOTH
    // sides: a negative delta means `prevReleasedAt` is in the FUTURE
    // relative to this worker's clock (cross-worker clock skew / NTP drift)
    // - that is evidence of clock drift, not evidence of a clean recent
    // stop, and must NOT skip the grace (a split-brain window otherwise).
    // NEVER awaited here (see this method's own step 4 doc comment) - the
    // duration is computed and handed back via `SessionLease.graceMs` for
    // the caller to wait out, deferred and cancellable.
    let releasedRecently = false;
    if (prevReleasedAt !== null) {
      const delta = this.now().getTime() - prevReleasedAt.getTime();
      releasedRecently = delta >= 0 && delta < RELEASE_FRESHNESS_MS;
    }
    const graceMs = releasedRecently ? 0 : this.timing.takeoverGraceMs;

    // wp_lease_takeovers_total: a real takeover is a mint that replaced a
    // DIFFERENT previous owner - a never-leased instance (prevOwnerWorkerId
    // null) or a worker re-minting its OWN still-held lease are both
    // excluded by design.
    if (prevOwnerWorkerId !== null && prevOwnerWorkerId !== this.workerId) {
      this.metrics.incrementTakeovers();
    }

    // wp_fence_regression_total: canary only - a minted fence that is not
    // strictly greater than the last fence THIS PROCESS saw for this
    // instance should never happen (Postgres mints monotonically per
    // instance), so this branch is never expected to execute in practice.
    const lastSeen = this.lastSeenFence.get(instanceId);
    if (lastSeen !== undefined && fence <= lastSeen) {
      this.metrics.incrementFenceRegression();
    }
    this.lastSeenFence.set(instanceId, fence);

    return { instanceId, clientId, fence, workerId: this.workerId, graceMs };
  }

  /**
   * Graceful, voluntary release of `lease` - the counterpart to
   * heartbeat.ts's self-fence path (which NEVER calls this: fail-safe, we
   * may not own the lease any more by the time a self-fence decision
   * fires). FIXED order, never reordered:
   *
   *   1. `SessionOwner.close(instanceId)` - a no-op abort-in-flight-work
   *      hook this phase (a real socket close is P08's).
   *   2. `release.lua` compare-delete on the Redis key.
   *   3. `lease-state-repo.ts`'s `release` (fence-guarded Postgres release -
   *      the grace-skip authority for the NEXT acquirer).
   *
   * Redis errors during release are logged; the Postgres release is STILL
   * attempted (Postgres's `released_at` is the authority a future acquirer
   * checks to decide whether to skip the takeover grace, so it must be
   * attempted even when Redis cleanup fails). A zero-row Postgres release
   * (stale fence - we no longer hold it) is logged, never thrown (core
   * invariant 2, mirrors `lease-state-repo.ts release`'s own contract).
   */
  async release(lease: SessionLease): Promise<void> {
    const { instanceId, clientId, fence, workerId } = lease;
    const key = this.leaseKey(clientId, instanceId);

    // Step 1: abort in-flight work / close the session owner's hold on this instance.
    await this.sessionOwner.close(instanceId);

    // Step 2: Redis compare-delete.
    try {
      await this.leaseRedis.release(key, `${workerId}|${fence.toString()}`);
    } catch (err) {
      this.logger.error(
        'lease release: redis release failed - continuing to the Postgres release',
        {
          instanceId,
          err,
        },
      );
    }

    // Step 3: Postgres fence-guarded release (the grace-skip authority).
    // Runs INSIDE `withTenant`'s callback (never holding onto its `sql`
    // handle afterward) - `TenantDb.withTenant` releases the underlying
    // connection back to the pool the moment the callback returns, so using
    // that handle after the fact would be a use-after-release bug.
    const input: ReleaseInput = { instanceId, fence, workerId };
    const released = await this.tenantDb.withTenant(clientId, (sql) =>
      this.pgRelease({ clientId, sql }, input),
    );
    if (!released) {
      this.logger.warn(
        'lease release: Postgres release matched zero rows (stale fence) - not owned any more',
        {
          instanceId,
        },
      );
    }
  }
}
