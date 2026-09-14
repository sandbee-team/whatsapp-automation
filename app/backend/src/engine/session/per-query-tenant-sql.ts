import type { TenantDb, TenantQueryable } from '@wp/db';

/**
 * per-query-tenant-sql.ts (2026-09-14) - `buildPerQueryTenantSql`, the
 * tenant-scoped `sql` handle the session worker hands to long-lived
 * callbacks.
 *
 * WHY THIS EXISTS (a real production defect, found 2026-09-14):
 * `session-worker-runner-factory.ts` used to build its `InstanceCtx.sql` and
 * its `auditSql` by casting the bare `pg.Pool` to a tenant-scoped type. Under
 * the REAL production role that is broken in two different ways, because
 * `wp_scheduler` - unlike the dev/test superuser - does NOT have BYPASSRLS:
 *
 *   - READS FAIL SOFT. A FORCE-RLS `USING` predicate compares `client_id`
 *     against an unset `app.client_id`, which is NULL, so the row simply is
 *     not visible. `incrementQrAttempts` and `markPairingExpired` match zero
 *     rows and silently do nothing - no error, no log line.
 *   - WRITES FAIL HARD. An `audit_logs` INSERT trips the `WITH CHECK`
 *     predicate and raises SQLSTATE 42501, breaking the logged-out fail-safe
 *     path whose whole job is to record WHY an instance was taken offline.
 *
 * Both were reproduced directly against Postgres under `SET LOCAL ROLE
 * wp_scheduler`, and both disappear the moment `set_config('app.client_id',
 * …)` has run first - which is exactly what `withTenant` does. Every test
 * missed it because dev/test connects as the RLS-bypassing superuser
 * (`pg_roles`: `wp` has `rolbypassrls = t`, the production roles have `f`).
 * This was the FOURTH occurrence of that class in this repo; see
 * `.memory/lessons/2026-09-11-superuser-dev-db-hides-force-rls-zero-row-reads.md`.
 *
 * WHY PER-QUERY AND NOT ONE TRANSACTION: the handle is captured by callbacks
 * (pairing QR attempts, expiry, the instances adapter) that fire at arbitrary
 * later times over the life of a session. There is no single request boundary
 * to wrap, so each query opens its own short `withTenant` transaction. That
 * is the same shape `engine/fleet/inflight-db-port.ts` already uses for its
 * own `wp_scheduler` reads.
 *
 * CONSEQUENCE, deliberately accepted: two calls through this handle are two
 * separate transactions, so it must never be used for a multi-statement
 * atomic sequence. Every current caller is a single self-contained statement.
 * Anything needing atomicity takes `tenantDb.withTenant` directly, exactly as
 * the connection-update hook in the factory already does.
 */
export function buildPerQueryTenantSql(tenantDb: TenantDb, clientId: string): TenantQueryable {
  return {
    query: (text: string, params?: unknown[]) =>
      tenantDb.withTenant(clientId, (tx) => tx.query(text, params as never)),
  } as unknown as TenantQueryable;
}
