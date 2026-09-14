import { TIMING } from '@wp/domain';

/**
 * expected-takeover-check.ts (P09 U6 step 9, carried-forward P08 handoff) -
 * the REAL `expectedTakeoverCheck` predicate `runner-types.ts`'s
 * `CreateSessionRunnerDeps.expectedTakeoverCheck` expects, replacing the
 * P08 placeholder (`session-worker-runner-factory.ts`'s `async () => false`)
 * that made EVERY 440/`session_replaced` close pause the instance
 * unconditionally.
 *
 * Blueprint rule [R-13w], implemented verbatim: silent resolution (treat as
 * `session_replaced`, no pause) ONLY when this worker can point to a
 * lease-acquisition record for this instance with a HIGHER fence than the
 * replaced socket's fence, written within `leaseTtl + takeoverGrace`
 * (`TIMING.leaseTtlMs + TIMING.takeoverGraceMs`), AND the replaced socket
 * belongs to that transition (fence comparison is per-socket-generation -
 * `myFence` is the CALLER'S own fence for the socket that just closed, never
 * the instance's current-latest by some other means).
 *
 * Backed by `instance_lease_state` (`lease-state-repo.ts`'s own table): a
 * mint (`lease-mint-fence.sql`) is the only statement that both bumps
 * `current_fence` AND stamps `lease_seen_at = now()` in the SAME write - a
 * later bare renew (`lease-renew-batch.sql`) touches `lease_seen_at` again
 * without changing `current_fence`, so "current_fence > myFence AND
 * lease_seen_at is fresh" only stays true for the `leaseTtl + takeoverGrace`
 * window immediately after a genuine takeover mint (a live NEW owner keeps
 * renewing, which keeps `lease_seen_at` fresh - that is fine: this worker's
 * OWN 440 handling only ever runs once per close, so the predicate is
 * evaluated once per real disconnect, not polled).
 *
 * Fail-safe (core invariant 2): no row, a fence that is NOT strictly higher,
 * a stale `lease_seen_at`, or a query error/no-op all resolve to `false`
 * (unexpected - keep the existing pause behavior) - this function NEVER
 * treats an unclear read as "expected".
 *
 * Tenant-scoped: runs through the caller's own `TenantQueryable` (a
 * `TenantDb.withTenant(clientId, ...)` callback handle in production), never
 * a bare pool - `instance_lease_state` carries `client_id` and is subject to
 * the same tenant-isolation discipline as every other tenant table.
 */

export interface ExpectedTakeoverQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface LeaseStateRow extends Record<string, unknown> {
  current_fence: string | number | bigint;
  lease_seen_at: Date | string | null;
}

export interface CheckExpectedTakeoverInput {
  instanceId: string;
  clientId: string;
  myFence: bigint;
}

export interface CheckExpectedTakeoverOptions {
  /** Injectable "now" for deterministic unit tests - defaults to `Date.now()`. */
  now?: () => number;
  /** Injectable window (ms) - defaults to `TIMING.leaseTtlMs + TIMING.takeoverGraceMs`. */
  windowMs?: number;
}

/**
 * The predicate itself, given an already-fetched `instance_lease_state` row
 * (or `null` for no row) - split from the DB read so the decision logic has
 * a pure, synchronous unit test surface with no Postgres involved.
 */
export function isExpectedTakeover(
  row: { currentFence: bigint; leaseSeenAt: Date | null } | null,
  input: Pick<CheckExpectedTakeoverInput, 'myFence'>,
  options: CheckExpectedTakeoverOptions = {},
): boolean {
  if (row === null || row.leaseSeenAt === null) {
    return false;
  }
  if (!(row.currentFence > input.myFence)) {
    return false;
  }
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? TIMING.leaseTtlMs + TIMING.takeoverGraceMs;
  const ageMs = now() - row.leaseSeenAt.getTime();
  return ageMs >= 0 && ageMs <= windowMs;
}

/**
 * Reads `instance_lease_state` for `(input.instanceId, input.clientId)` and
 * applies `isExpectedTakeover`. Any query error propagates as `false` at the
 * `expectedTakeoverCheck` port boundary is NOT this function's job - the
 * caller (`buildSessionRunnerFor`'s wiring) decides how to log a thrown
 * error; this function itself throws on a genuine query failure (never
 * silently swallows a DB error into a false "unexpected", which would mask
 * an infra problem as a business decision) - see the wiring closure for the
 * fail-safe catch that turns a throw into `false` at the very edge.
 */
export async function checkExpectedTakeover(
  sql: ExpectedTakeoverQueryable,
  input: CheckExpectedTakeoverInput,
  options: CheckExpectedTakeoverOptions = {},
): Promise<boolean> {
  const result = await sql.query<LeaseStateRow>(
    `SELECT current_fence, lease_seen_at
       FROM instance_lease_state
      WHERE instance_id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId],
  );
  const row = result.rows[0];
  if (!row) {
    return isExpectedTakeover(null, input, options);
  }
  const leaseSeenAt =
    row.lease_seen_at === null
      ? null
      : row.lease_seen_at instanceof Date
        ? row.lease_seen_at
        : new Date(row.lease_seen_at);
  return isExpectedTakeover(
    { currentFence: BigInt(row.current_fence), leaseSeenAt },
    input,
    options,
  );
}

/**
 * Builds the `expectedTakeoverCheck` port `CreateSessionRunnerDeps` expects
 * (`(instanceId, clientId, myFence) => Promise<boolean>`), bound to a
 * `TenantDb`-style `withTenant` runner. A query error is caught here and
 * resolved as `false` (fail-safe boundary, core invariant 2: an unclear read
 * must never be read as "expected" - it must fall through to the existing
 * pause behavior, never propagate as an unhandled rejection out of the
 * runner's own close-handling path).
 */
export function buildExpectedTakeoverCheck(deps: {
  withTenant: <T>(
    clientId: string,
    fn: (sql: ExpectedTakeoverQueryable) => Promise<T>,
  ) => Promise<T>;
  onError?: (err: unknown) => void;
  now?: () => number;
  windowMs?: number;
}): (instanceId: string, clientId: string, myFence: bigint) => Promise<boolean> {
  return async (instanceId, clientId, myFence) => {
    try {
      return await deps.withTenant(clientId, (sql) =>
        checkExpectedTakeover(
          sql,
          { instanceId, clientId, myFence },
          { now: deps.now, windowMs: deps.windowMs },
        ),
      );
    } catch (err) {
      deps.onError?.(err);
      return false;
    }
  };
}
