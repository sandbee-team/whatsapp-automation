import { bindQueryParams, loadQuery, type WorkerDb, type WorkerQueryable } from '@wp/db';

/**
 * lease-state-repo.ts (P06 Unit U3) - the canonical, thin repo over
 * `instance_lease_state`'s fence-mint / renew-batch / release / discovery-
 * scan statements (see each `db/queries/lease-*.sql` file's own header
 * comment for the invariants it enforces). No ORM re-implementation, no
 * alternative fence math - every fence rule lives inside the loaded SQL
 * text itself.
 *
 * SAFETY BOUNDARY (core-invariants + safety-compliance, mirrors
 * `modules/queue/queue.repo.ts`): no parameter, flag, or "admin override"
 * here may skip a fence/worker/tenant predicate - those live inside the
 * `.sql` files. `renewBatch` runs as exactly ONE statement across every
 * lease a worker holds; a per-lease renew loop must NEVER be added here
 * (ADR 0018 §4 / scope-delta row 2 - see lease-renew-batch.sql's own header).
 * A statement that THROWS (PG unavailable/timeout) must never be reported
 * the same way as a statement that SUCCEEDS while omitting a row (a fence
 * conflict) - core invariant 2 forbids treating "the database is down" as
 * "I lost my lease" (P06 U5 heartbeat depends on this distinction).
 */

/**
 * Minimal query surface every function here needs - structurally
 * compatible with `pg.Pool` / `pg.Client` / `pg.PoolClient` / the
 * `TenantQueryable` a `TenantDb.withTenant` callback receives (and any test
 * stub), the same pattern `modules/queue/queue.repo.ts`'s `QueueQueryable`
 * already establishes. Callers own the connection/transaction lifecycle;
 * this module owns none of its own.
 */
export interface LeaseQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Mint context - `clientId` plus a query executor bound to a SINGLE
 * transaction: `mintFence` runs two statements (read-released, then the
 * fence upsert) that MUST commit or roll back together, so `ctx.sql` must
 * already be the same transactional handle a caller obtained from
 * `TenantDb.withTenant`'s callback (or an equivalent single-transaction
 * stub in tests) - never a bare pool that could hand the two statements
 * different connections.
 */
export interface MintFenceCtx {
  clientId: string;
  sql: LeaseQueryable;
}

export interface MintFenceInput {
  instanceId: string;
  workerId: string;
}

export interface MintFenceResult {
  fence: bigint;
  prevReleasedAt: Date | null;
  /**
   * The worker id that owned this lease immediately BEFORE this mint (P06
   * U5 extension), or `null` for a never-leased instance. Used by
   * `LeaseManager.acquire` to decide whether this mint is a real takeover
   * (a DIFFERENT worker previously held it) for `wp_lease_takeovers_total`.
   */
  prevOwnerWorkerId: string | null;
}

interface ReadReleasedRow extends Record<string, unknown> {
  released_at: Date | null;
  owner_worker_id: string | null;
}

interface MintFenceRow extends Record<string, unknown> {
  current_fence: string | number | bigint;
}

/**
 * Mints a new, strictly-monotonic fence for `(ctx.clientId, input.instanceId)`
 * and marks it owned by `input.workerId`. Runs `lease-mint-read-released`
 * (locks + reads the current `released_at`, FOR UPDATE) followed by
 * `lease-mint-fence` (the atomic upsert bump) - both against `ctx.sql`, so
 * both participate in whatever transaction the caller already opened.
 * `prevReleasedAt` is `null` both for a never-leased instance (no prior row)
 * and for an instance that was minted without ever being cleanly released in
 * between (the `released_at` value read back before THIS mint clears it) -
 * callers that care about the distinction should inspect the read separately
 * before calling.
 */
export async function mintFence(
  ctx: MintFenceCtx,
  input: MintFenceInput,
): Promise<MintFenceResult> {
  const readQuery = await loadQuery('lease-mint-read-released');
  const readParams = bindQueryParams(readQuery, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
  });
  const readResult = await ctx.sql.query<ReadReleasedRow>(readQuery.text, readParams);
  const prevReleasedAt = readResult.rows[0]?.released_at ?? null;
  const prevOwnerWorkerId = readResult.rows[0]?.owner_worker_id ?? null;

  const mintQuery = await loadQuery('lease-mint-fence');
  const mintParams = bindQueryParams(mintQuery, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    worker: input.workerId,
  });
  const mintResult = await ctx.sql.query<MintFenceRow>(mintQuery.text, mintParams);
  const row = mintResult.rows[0];
  if (!row) {
    throw new Error(
      `mintFence: lease-mint-fence.sql returned no row for instance ${input.instanceId} - the INSERT ... ON CONFLICT DO UPDATE ... RETURNING should always return exactly one row`,
    );
  }

  return { fence: BigInt(row.current_fence), prevReleasedAt, prevOwnerWorkerId };
}

export interface RenewBatchLease {
  instanceId: string;
  fence: number | bigint;
}

export interface RenewBatchInput {
  workerId: string;
  leases: readonly RenewBatchLease[];
}

export type RenewBatchResult = { ok: true; renewed: Set<string> } | { ok: false; error: unknown };

interface RenewBatchRow extends Record<string, unknown> {
  instance_id: string;
}

/**
 * Renews liveness (`lease_seen_at = now()`) for every lease in
 * `input.leases` that `input.workerId` still holds at its current fence, in
 * exactly ONE statement (`lease-renew-batch.sql`) - never a per-lease loop
 * (see this module's own header SAFETY BOUNDARY). Requires a `WorkerDb`
 * (`@wp/db`'s `createWorkerDb`/`withWorker`), NOT a bare `LeaseQueryable`:
 * `set_config('app.worker_id', ...)` is transaction-local, so it and the
 * renew UPDATE it gates MUST share one pinned connection/transaction - a
 * plain pool call to set the GUC evaporates before a later, separately
 * acquired connection ever sees it (verified live: this was a real bug, not
 * a theoretical one - C1 finding 2). `withWorker` opens exactly that one
 * transaction, sets the GUC, and hands this function a `WorkerQueryable` to
 * run the renew statement against - matching the `lease_owner_renew_update`
 * / `lease_owner_renew_select` RLS policies' key (migration 0019, ADR 0029
 * §3, corrected from the single non-functional FOR UPDATE-only policy 0018
 * shipped with - C1 finding 1: an UPDATE's WHERE/RETURNING-visible rows also
 * need a FOR SELECT/ALL policy, which 0018 never had).
 *
 * Returns `{ok: true, renewed}` where `renewed` is the set of instance ids
 * that WERE renewed - any lease in `input.leases` NOT present in `renewed`
 * has either gone stale (fence mismatch) or is no longer owned by this
 * worker (RLS-filtered); both are indistinguishable fence-conflict outcomes
 * for the caller to self-fence on, by design (fail-safe).
 *
 * Returns `{ok: false, error}` ONLY when the statement itself failed to run
 * (e.g. Postgres unavailable, timeout, connection error) - this is NEVER
 * conflated with "some leases are stale": a caller (the P06 U5 heartbeat)
 * must treat `ok: false` as "liveness unknown, do not assume fences lost"
 * per core invariant 2, not as a mass fence conflict.
 *
 * Empty `input.leases` short-circuits to `{ok: true, renewed: <empty set>}`
 * without any round trip to the database - there is nothing to renew.
 */
export async function renewBatch(
  workerDb: WorkerDb,
  input: RenewBatchInput,
): Promise<RenewBatchResult> {
  if (input.leases.length === 0) {
    return { ok: true, renewed: new Set<string>() };
  }

  try {
    return await workerDb.withWorker(input.workerId, async (tx: WorkerQueryable) => {
      const query = await loadQuery('lease-renew-batch');
      const params = bindQueryParams(query, {
        ids: input.leases.map((lease) => lease.instanceId),
        fences: input.leases.map((lease) => lease.fence.toString()),
        worker: input.workerId,
      });

      const result = await tx.query<RenewBatchRow>(query.text, params);
      const renewed = new Set(result.rows.map((row) => row.instance_id));
      return { ok: true, renewed };
    });
  } catch (error) {
    return { ok: false, error };
  }
}

export interface ReleaseCtx {
  clientId: string;
  sql: LeaseQueryable;
}

export interface ReleaseInput {
  instanceId: string;
  fence: number | bigint;
  workerId: string;
}

interface ReleaseRow extends Record<string, unknown> {
  instance_id: string;
}

/**
 * Clean, voluntary lease release for `(ctx.clientId, input.instanceId)` at
 * `input.fence`, owned by `input.workerId`. Returns `true` when the row was
 * updated, `false` for a stale fence / wrong worker / wrong tenant - this
 * function never throws for "nothing to release" (`lease-release.sql`'s own
 * header comment).
 */
export async function release(ctx: ReleaseCtx, input: ReleaseInput): Promise<boolean> {
  const query = await loadQuery('lease-release');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker: input.workerId,
  });

  const result = await ctx.sql.query<ReleaseRow>(query.text, params);
  return result.rows.length > 0;
}

export interface ScanUnownedInput {
  staleMs: number;
  maxRows: number;
}

export interface UnownedLease {
  instanceId: string;
  clientId: string;
}

interface ScanUnownedRow extends Record<string, unknown> {
  instance_id: string;
  client_id: string;
}

/**
 * Cross-tenant discovery scan of unowned, online instances
 * (`lease-scan-unowned.sql`, executes as `wp_scheduler`). Query-only - the
 * discovery LOOP that runs this on a tick is P09's, out of scope here.
 */
export async function scanUnowned(
  sql: LeaseQueryable,
  input: ScanUnownedInput,
): Promise<UnownedLease[]> {
  const query = await loadQuery('lease-scan-unowned');
  const params = bindQueryParams(query, {
    stale_ms: input.staleMs,
    max_rows: input.maxRows,
  });

  const result = await sql.query<ScanUnownedRow>(query.text, params);
  return result.rows.map((row) => ({ instanceId: row.instance_id, clientId: row.client_id }));
}
