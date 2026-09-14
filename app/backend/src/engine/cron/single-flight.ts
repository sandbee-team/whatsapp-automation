/**
 * single-flight.ts (P12 Unit U4, step 7) - the Postgres advisory-lock
 * single-flight primitive both cron loops (reaper, reconciler) run every
 * tick through, so two `ROLE=cron` processes can never run the SAME loop
 * concurrently.
 *
 * `pg_try_advisory_xact_lock`, NOT `pg_advisory_lock` (session-scoped) and
 * NOT the blocking `pg_advisory_xact_lock`: canon (blueprint row 18 / ADR
 * 0009) says "Leader-lease row, not `pg_advisory_lock`" because *session*
 * advisory locks are unreliable under PgBouncer transaction pooling (ADR
 * 0006/0009) - a lock taken on one pooled connection can be "released" by
 * PgBouncer handing that same backend to a different client's session, or
 * never released at all if the app process dies without an explicit
 * unlock. A *transaction*-scoped advisory lock has none of that hazard: it
 * is acquired and released entirely within ONE transaction on ONE pooled
 * connection, and Postgres itself releases it at COMMIT/ROLLBACK - exactly
 * the pooled-connection lifetime PgBouncer transaction mode already grants.
 * Verified live against this repo's own dev Postgres: `SET ROLE
 * wp_scheduler; SELECT pg_try_advisory_xact_lock(...)` returns `t` with no
 * additional GRANT - Postgres grants every `pg_try_advisory_xact_lock`
 * variant to PUBLIC by default. The `_try_` (non-blocking) variant is used
 * so a second cron process observes an immediate `false` and returns as a
 * clean no-op tick, rather than blocking the pooled connection waiting on a
 * lock some OTHER process holds.
 *
 * Lock key construction mirrors `db/src/migrate.ts`'s own
 * `ADVISORY_LOCK_NAME` idiom deliberately: the namespace and local part are
 * joined with `+` at runtime, never written as one `'wp:...'` string
 * literal, so this Postgres lock name (not a Redis key at all) never trips
 * the `wp/key-construction` eslint guard, which only polices Redis key
 * literals under `platform/redis/**`.
 */

const ADVISORY_LOCK_NAMESPACE = 'wp' + ':cron';

/** Every cron loop gets its own DISTINCT lock key so different loops can run concurrently with each other - only two copies of the SAME loop are ever mutually exclusive. `pacingEvaluator` added P13a Unit U1 (5-minute warm-up ladder sweep). `walletRollup`/`walletReconcile` added P18 Unit U5 - the wallet-charger drain loop is deliberately NOT single-flighted (its Redis SPOP/RPOP calls are atomic and idempotent across replicas), so it gets no lock key here. `contactImport` added P20 Unit U5 - the resumable CSV import sweep. `optoutMirrorReconcile`/`contactImportPurge` added P20 Unit U8 - the nightly opt-out mirror reconciler and the hourly import-error-row/object retention purge. `broadcastSnapshot`/`broadcastExpansion` added P23 Unit U4 - the broadcast audience-snapshot and ref-first expansion sweeps. `broadcastCancelBookkeeping` added P23 Unit U5, step 6 - the resumable cancel-bookkeeping stamping sweep (never the enforcement point - see cancel-bookkeeping.ts's own header). `epochReconcile` added P23 Unit U6, step 7 - the 5-minute fleet-wide epoch-stranding reconciliation sweep (belt-and-braces for a hook missed by a crash). `broadcastFunnelActive`/`broadcastFunnelHourly` added P23a Unit U2 - the progress-funnel recompute sweep's two cadences (5s active-campaign recount, hourly crash-reconciliation sweep - see `funnel.sweep.ts`'s own header). `metricRollup`/`optoutRateCheck` added P25 Unit U3 - the 5-minute fleet-wide metric rollup collector and the hourly per-client opt-out-rate check (`cron-wiring-rollups.ts`). */
export const CRON_LOCK_KEYS = {
  reaper: `${ADVISORY_LOCK_NAMESPACE}:reaper`,
  reconciler: `${ADVISORY_LOCK_NAMESPACE}:reconciler`,
  pacingEvaluator: `${ADVISORY_LOCK_NAMESPACE}:pacing-evaluator`,
  walletRollup: `${ADVISORY_LOCK_NAMESPACE}:wallet-rollup`,
  walletReconcile: `${ADVISORY_LOCK_NAMESPACE}:wallet-reconcile`,
  contactImport: `${ADVISORY_LOCK_NAMESPACE}:contact-import`,
  optoutMirrorReconcile: `${ADVISORY_LOCK_NAMESPACE}:optout-mirror-reconcile`,
  contactImportPurge: `${ADVISORY_LOCK_NAMESPACE}:contact-import-purge`,
  broadcastSnapshot: `${ADVISORY_LOCK_NAMESPACE}:broadcast-snapshot`,
  broadcastExpansion: `${ADVISORY_LOCK_NAMESPACE}:broadcast-expansion`,
  broadcastCancelBookkeeping: `${ADVISORY_LOCK_NAMESPACE}:broadcast-cancel-bookkeeping`,
  epochReconcile: `${ADVISORY_LOCK_NAMESPACE}:epoch-reconcile`,
  broadcastFunnelActive: `${ADVISORY_LOCK_NAMESPACE}:broadcast-funnel-active`,
  broadcastFunnelHourly: `${ADVISORY_LOCK_NAMESPACE}:broadcast-funnel-hourly`,
  metricRollup: `${ADVISORY_LOCK_NAMESPACE}:metric-rollup`,
  optoutRateCheck: `${ADVISORY_LOCK_NAMESPACE}:optout-rate-check`,
  adminRelaxExpiry: `${ADVISORY_LOCK_NAMESPACE}:admin-relax-expiry`,
  // P34 U-upload (ADR 0052 accepted item 7) - the 90-day media asset
  // retention purge, same hourly cadence as contactImportPurge.
  mediaAssetPurge: `${ADVISORY_LOCK_NAMESPACE}:media-asset-purge`,
} as const;

export type CronLockKey = (typeof CRON_LOCK_KEYS)[keyof typeof CRON_LOCK_KEYS];

/** Minimal query surface this module needs from a pooled connection - never `pg.PoolClient` itself, so a caller can't reach for `.release()`/raw `BEGIN` and break the transaction this module owns. */
export interface SingleFlightQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** The minimal pool port this module needs: acquire one connection, release it when done. */
export interface SingleFlightPool {
  connect(): Promise<SingleFlightQueryable & { release(err?: Error): void }>;
}

export type SingleFlightOutcome = 'ran' | 'lock_not_acquired' | 'db_error';

export interface RunWithSingleFlightLockResult {
  outcome: SingleFlightOutcome;
  /** The error that caused `outcome: 'db_error'` - `undefined` for every other outcome. */
  error?: unknown;
}

/**
 * Opens ONE transaction, attempts `pg_try_advisory_xact_lock(hashtext($1))`
 * for `lockKey`, and:
 *   - lock acquired -> runs `fn` inside the SAME transaction, then COMMITs
 *     (which releases the lock) -> `{ outcome: 'ran' }`. This module hands
 *     `fn` the lock-holding `tx` so a caller CAN make its own work part of
 *     that same transaction - whether it actually does is the caller's
 *     choice, not a guarantee this module makes on its behalf (C1 NOTE 6
 *     correction: `cron-wiring.ts`'s two `runOne` closures deliberately do
 *     NOT thread `tx` through, since the sweeps they drive are cross-tenant
 *     while their per-tenant writes must run in their OWN transaction - see
 *     that module's own header). This function's contract is CONCURRENCY
 *     ONLY: at most one caller runs `fn` for a given `lockKey` at a time. It
 *     makes no atomicity claim about whatever `fn` itself does with the
 *     `tx` it receives.
 *   - lock NOT acquired (another cron process holds it right now) -> rolls
 *     back immediately WITHOUT running `fn` -> `{ outcome:
 *     'lock_not_acquired' }`. This is a normal, expected steady state under
 *     more than one cron replica, never logged as an error.
 *   - any database error (acquiring the connection, taking the lock,
 *     running `fn`, or committing) -> rolls back, swallows the error into
 *     the result rather than throwing -> `{ outcome: 'db_error', error }`.
 *     The caller (`cron-loop.ts`) is the one place that decides how to back
 *     off; this function never retries itself.
 */
export async function runWithSingleFlightLock(
  pool: SingleFlightPool,
  lockKey: CronLockKey,
  fn: (tx: SingleFlightQueryable) => Promise<void>,
): Promise<RunWithSingleFlightLockResult> {
  let client: (SingleFlightQueryable & { release(err?: Error): void }) | undefined;

  try {
    client = await pool.connect();
  } catch (err) {
    return { outcome: 'db_error', error: err };
  }

  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      const lockResult = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS pg_try_advisory_xact_lock',
        [lockKey],
      );
      const acquired = lockResult.rows[0]?.pg_try_advisory_xact_lock === true;

      if (!acquired) {
        await client.query('ROLLBACK');
        releaseError = undefined;
        return { outcome: 'lock_not_acquired' };
      }

      await fn(client);
      await client.query('COMMIT');
      releaseError = undefined;
      return { outcome: 'ran' };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
        releaseError = undefined;
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      return { outcome: 'db_error', error: err };
    }
  } finally {
    if (releaseError !== undefined) {
      client.release(releaseError as Error);
    } else {
      client.release();
    }
  }
}
