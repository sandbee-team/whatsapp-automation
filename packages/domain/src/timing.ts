/**
 * The one exported timing object for lease/fence, dispatch, and reaper
 * timeouts (blueprint "Lease + fence" [R-33s]). Two ordering invariants are
 * load-bearing and are asserted in `timing.test.ts`:
 *
 *   1. `sendTimeoutMs < claimExpiryMs - reaperGraceMs` - a send must time
 *      itself out well before the reaper would otherwise reclaim the lease,
 *      so a slow-but-legitimate send is never raced by the reaper.
 *   2. `takeoverGraceMs + leaseTtlMs > watchdogMs` - a lease takeover must
 *      not be able to finish and open a new socket before the previous
 *      owner's local watchdog has had a chance to self-fence.
 */
export const TIMING = Object.freeze({
  /** Redis lease TTL (`SET NX PX`). */
  leaseTtlMs: 30_000,
  /** Interval between lease heartbeat (compare-and-extend) attempts. */
  heartbeatMs: 10_000,
  /** Wait after minting a new fence, before opening the socket. */
  takeoverGraceMs: 15_000,
  /** Local monotonic self-fence deadline if no heartbeat renewal succeeds. */
  watchdogMs: 15_000,
  /** Hard timeout on a single provider send call. */
  sendTimeoutMs: 45_000,
  /** How long a `processing` claim's lease is valid before the reaper acts. */
  claimExpiryMs: 90_000,
  /** Grace period the reaper waits past `lease_expires_at` before acting. */
  reaperGraceMs: 30_000,
  /** Evidence window for reconciling a `needs_reconcile` job via echo match. */
  reconcileWindowMs: 600_000,
  /** Interval between reaper sweeps (P12). */
  reaperIntervalMs: 15_000,
  /** Interval between echo-reconciler sweeps (P12). */
  reconcilerIntervalMs: 30_000,
  /** Echo hash-match tolerance either side of the evidence's `observed_at` (P12). */
  echoToleranceMs: 300_000,
  /** Interval between per-instance pacing-evaluator sweeps (P13a) - the warm-up ladder evaluator (ADR 0018 S4: no singleton loop may be O(active) faster than 5 minutes). */
  pacingEvaluatorIntervalMs: 300_000,
  /**
   * Hard timeout on a single lease Redis command (e.g. the compare-and-extend
   * heartbeat renew). Consumed by `app/backend/src/engine/lease/lease-redis.ts`.
   * Must resolve well inside one `heartbeatMs` interval so a stuck Redis
   * command can never silently blow through the watchdog's self-fence
   * deadline - the command must fail fast, not hang.
   */
  redisCommandTimeoutMs: 2_000,
  /**
   * Bound on establishing a new Postgres connection (`connectionTimeoutMillis`
   * on `@wp/db`'s `createPool`). Consumed by session-runner wiring so a
   * hung connect attempt fails fast rather than blocking a worker forever.
   */
  pgConnectTimeoutMs: 3_000,
  /**
   * Server-side `statement_timeout` for pools used by the session engine
   * (`@wp/db`'s `createPool({ statementTimeoutMs })`). Bounds any single
   * query so the PG leg of a session runner can never hang indefinitely.
   */
  pgStatementTimeoutMs: 5_000,
  /** Interval between wallet-charger drain sweeps (P18 U8b). */
  walletChargerDrainIntervalMs: 15_000,
  /** Interval between wallet rollup sweeps - hourly, idempotent, upserts today+yesterday UTC (P18 U8b). */
  walletRollupIntervalMs: 3_600_000,
  /** Interval between wallet reconciler sweeps - hourly over [now-25h, now-10min), every write guard-keyed - ADR 0038 S10 (P18 U8b). */
  walletReconcileIntervalMs: 3_600_000,
  /** Interval between contact-import cron sweeps - one bounded batch (500 CSV records) per client per tick (P20 U5). */
  contactImportTickMs: 2_000,
  /** Interval between opt-out mirror reconciler sweeps - daily (P20 U8). */
  optoutMirrorReconcileIntervalMs: 86_400_000,
  /** Interval between contact-import error-row retention purge sweeps - hourly (P20 U8). */
  contactImportPurgeIntervalMs: 3_600_000,
  /** Interval between media-asset retention purge sweeps - hourly, same cadence as contactImportPurgeIntervalMs (P34 U-upload, ADR 0052 accepted item 7). */
  mediaAssetPurgeIntervalMs: 3_600_000,
});
