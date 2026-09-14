import type { TenantQueryable } from '@wp/db';
import type { DropReason, RealtimeConnectionSnapshot, RealtimeHub } from './hub.js';
import { loadAuthzSnapshot, type AuthzSnapshotRow } from './authz.repo.js';

/**
 * modules/realtime/authz-tick.ts (P05 Unit U3b) - the periodic SSE
 * re-authorisation tick (blueprint: "Channel authorisation ... is re-checked
 * on membership change and on token_epoch bump; a revoked membership drops
 * the socket within 5 seconds" [R-35]). Runs at most every `tickMs`
 * (`SSE_AUTHZ_TICK_MS`, default 5000), and issues exactly ONE batched query
 * per tick over the DISTINCT user ids currently connected - never one query
 * per connection (phase risk, canon).
 *
 * Fail-safe (core invariant 2): if the tick's own query FAILS (Postgres
 * down/slow), this does NOT drop everyone and does NOT skip forever - it
 * logs `event_type: 'realtime.authz_tick_failed'` with `error_class`, counts
 * `wp_sse_authz_tick_errors_total`, and keeps every connection for THIS tick
 * (unverifiable != revoked). Only once `maxConsecutiveFailures`
 * (`SSE_AUTHZ_MAX_CONSECUTIVE_FAILURES`, default 6 = 30s at the default tick
 * interval) consecutive ticks fail does it drop ALL connections with reason
 * `'authz_unverifiable'` - unverifiable authorisation must not persist
 * indefinitely either. A single successful tick resets the consecutive-
 * failure counter back to zero.
 *
 * Per-connection drop rules (checked per user, applied to every connection
 * that user holds):
 *   - user id absent from the snapshot result (deleted/never existed) ->
 *     'membership_revoked'
 *   - `row.tokenEpoch !== conn.epoch` -> 'token_epoch' (checked BEFORE the
 *     membership checks below: an epoch bump is a distinct security signal -
 *     logout/role change/impersonation revocation - independent of whether
 *     the membership itself also happens to be gone)
 *   - `row.clientId === null` (no membership row) or `row.clientId !==
 *     conn.clientId` (moved to a different workspace) -> 'membership_revoked'
 *   - `row.clientStatus === 'suspended'` -> 'client_suspended'
 *   - `row.clientStatus === 'closed'` -> 'client_closed'
 *
 * `users.status` is intentionally NOT part of the snapshot (migration 0017)
 * and is not checked here - a disabled/locked user identity is expected to
 * bump `token_epoch` at the same time (session.service.ts's own epoch-bump
 * call sites), so the token_epoch check above already covers that case
 * without this tick needing a second, redundant signal.
 */

export interface AuthzTickMetricsPort {
  incrementAuthzTickErrors: () => void;
}

export interface AuthzTickLoggerPort {
  info: (fields: Record<string, unknown>, msg: string) => void;
  error: (fields: Record<string, unknown>, msg: string) => void;
}

export interface CreateAuthzTickOptions {
  hub: RealtimeHub;
  db: TenantQueryable;
  tickMs: number;
  maxConsecutiveFailures: number;
  metrics: AuthzTickMetricsPort;
  logger: AuthzTickLoggerPort;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Injectable deadline timer (test seam) - defaults to the real `setTimeout`. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** Sentinel thrown when the snapshot load did not settle within the tick's own deadline. */
class AuthzTickTimeoutError extends Error {
  constructor() {
    super('realtime authz tick query did not settle within its deadline');
    this.name = 'AuthzTickTimeoutError';
  }
}

export interface TickResult {
  usersChecked: number;
  queries: 0 | 1;
  dropped: Partial<Record<DropReason, number>>;
}

export interface AuthzTick {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<TickResult>;
}

function emptyDropped(): Partial<Record<DropReason, number>> {
  return {};
}

/** Decides the drop reason for one user's row, or `undefined` if the user is still authorised. */
function reasonFor(
  row: AuthzSnapshotRow | undefined,
  conn: RealtimeConnectionSnapshot,
): DropReason | undefined {
  if (!row) {
    return 'membership_revoked';
  }
  if (row.tokenEpoch !== conn.epoch) {
    return 'token_epoch';
  }
  if (row.clientId === null || row.clientId !== conn.clientId) {
    return 'membership_revoked';
  }
  if (row.clientStatus === 'suspended') {
    return 'client_suspended';
  }
  if (row.clientStatus === 'closed') {
    return 'client_closed';
  }
  return undefined;
}

export function createAuthzTick(options: CreateAuthzTickOptions): AuthzTick {
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const setTimeoutFn = options.setTimeout ?? setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout;

  let consecutiveFailures = 0;
  let handle: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;

  /**
   * Races `loadAuthzSnapshot` against a deadline equal to `tickMs` - a
   * dependency that never settles (fully hung, not merely slow-but-alive;
   * hunt item 8's "slow" case already returns eventually and is handled by
   * the plain `catch` below) must still COUNT AS A FAILED TICK, or
   * `consecutiveFailures` never increments and the fail-safe budget
   * (core invariant 2) can never trip while connections sit on stale authz
   * forever. The late-resolving real query result (if the deadline fires
   * first) is intentionally never awaited further by the caller - whichever
   * promise settles first via `Promise.race` decides this tick's outcome,
   * and the other is left to resolve into the void, its result discarded.
   */
  async function loadWithDeadline(userIds: readonly string[]): Promise<AuthzSnapshotRow[]> {
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineHandle = setTimeoutFn(() => {
        reject(new AuthzTickTimeoutError());
      }, options.tickMs);
    });
    try {
      return await Promise.race([loadAuthzSnapshot(options.db, userIds), deadline]);
    } finally {
      if (deadlineHandle !== undefined) {
        clearTimeoutFn(deadlineHandle);
      }
    }
  }

  async function runOnce(): Promise<TickResult> {
    const userIds = options.hub.distinctUserIds();

    if (userIds.length === 0) {
      return { usersChecked: 0, queries: 0, dropped: emptyDropped() };
    }

    let rows: AuthzSnapshotRow[];
    try {
      rows = await loadWithDeadline(userIds);
    } catch (err) {
      consecutiveFailures += 1;
      options.metrics.incrementAuthzTickErrors();
      const errorClass =
        err instanceof AuthzTickTimeoutError
          ? 'timeout'
          : err instanceof Error
            ? err.name
            : 'Error';
      options.logger.error(
        { event_type: 'realtime.authz_tick_failed', error_class: errorClass },
        'realtime authz tick failed',
      );

      if (consecutiveFailures < options.maxConsecutiveFailures) {
        // Fail-safe: unverifiable this tick != revoked. Keep every
        // connection and retry next tick.
        return { usersChecked: userIds.length, queries: 1, dropped: emptyDropped() };
      }

      // Failure budget exhausted: unverifiable authorisation must not
      // persist indefinitely - drop everyone, then reset the counter so a
      // recovered database doesn't immediately re-trip the budget on old
      // (now-gone) connections.
      const dropped = emptyDropped();
      const droppedCount = options.hub.dropWhere(() => true, 'authz_unverifiable');
      if (droppedCount > 0) {
        dropped.authz_unverifiable = droppedCount;
      }
      consecutiveFailures = 0;
      return { usersChecked: userIds.length, queries: 1, dropped };
    }

    consecutiveFailures = 0;

    const rowByUserId = new Map(rows.map((row) => [row.userId, row]));
    const dropped = emptyDropped();

    // `hub.dropWhere(predicate, reason)` applies ONE fixed reason to every
    // connection it closes in a single call, so connections that need
    // DIFFERENT reasons (e.g. one user's token_epoch bump alongside
    // another's membership revocation, in the same tick) can't be dropped
    // in one pass. Two passes instead: first decide each live connection's
    // reason (a pure, side-effect-free predicate call - `dropWhere`'s
    // predicate itself only decides membership, closing happens inside the
    // hub only for matches), then issue one `dropWhere` call per DISTINCT
    // reason actually present. Both passes are pure in-process work over
    // the already-fetched snapshot - no additional queries.
    const reasonByConnectionId = new Map<string, DropReason>();
    // `dropWhere`'s predicate receives every live connection's snapshot
    // regardless of what it returns - returning `false` here is a
    // non-destructive "observe only" pass (nothing closes), used purely to
    // decide each connection's reason before the real drop passes below.
    options.hub.dropWhere((conn) => {
      const row = rowByUserId.get(conn.userId);
      const reason = reasonFor(row, conn);
      if (reason !== undefined) {
        reasonByConnectionId.set(conn.connectionId, reason);
      }
      return false;
    }, 'membership_revoked');

    const reasonsPresent = new Set(reasonByConnectionId.values());
    for (const reason of reasonsPresent) {
      const count = options.hub.dropWhere(
        (conn) => reasonByConnectionId.get(conn.connectionId) === reason,
        reason,
      );
      if (count > 0) {
        dropped[reason] = (dropped[reason] ?? 0) + count;
      }
    }

    return { usersChecked: userIds.length, queries: 1, dropped };
  }

  return {
    start() {
      handle = setIntervalFn(() => {
        // Single-flight: a slow-but-not-down dependency (canon hunt item 8)
        // must never let ticks pile up into overlapping concurrent queries -
        // if the previous tick's runOnce is still in flight when the
        // interval fires again, this fire is skipped; the NEXT interval
        // fire after the in-flight call settles starts a fresh tick.
        if (tickInFlight) return;
        tickInFlight = true;
        void runOnce().finally(() => {
          tickInFlight = false;
        });
      }, options.tickMs);
    },
    stop() {
      if (handle !== undefined) {
        clearIntervalFn(handle);
        handle = undefined;
      }
    },
    runOnce,
  };
}
