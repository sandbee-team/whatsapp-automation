import { createHash } from 'node:crypto';

/**
 * staff-audit.ts (P19 Unit U5, step 8; P28 Unit U3a, step 4 rewrite) - the
 * `AdminAppQueryable`/`AdminAppPool` connection shapes, `withAdminAppRole`
 * (now used ONLY by the read-only `/internal/v1` routes - `GET /topups`,
 * `GET /plans`; every MUTATION runs through `with-staff-mutation.ts#
 * withStaffMutation` instead, which owns its own `wp_app`-then-
 * `wp_admin_app`-on-demand connection), and `computeRequestHash`.
 *
 * SINGLE UNCONDITIONAL GUARANTEE (replaces the P19-era "two roles, one
 * transaction, but the audit row's transaction scope differs by route"
 * design this file used to document): every staff MUTATION now writes its
 * `staff_audit_log` row and its business effect in ONE transaction, via
 * `withStaffMutation` - either both commit or neither does, unconditionally,
 * for every route (see that module's own header for the exact binding
 * order). This file no longer owns any part of that guarantee; it only
 * supplies the plumbing the READ routes and the hash helper need.
 *
 * `computeRequestHash` mirrors `modules/messages/messages.service.ts`'s
 * `computeRequestHash` in spirit (SHA-256 of a canonical JSON body) but now
 * hashes `{method, path, body}` - P19's version hashed the body alone, which
 * meant the SAME idempotency key + body replayed against a DIFFERENT route
 * template would incorrectly look like a matching replay instead of a
 * reuse-across-routes conflict. Kept as a local copy rather than an import
 * from `modules/messages` (a sibling module - no-deep-module-import forbids
 * reaching past its public surface, which does not export this helper).
 */

export interface AdminAppQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface AdminAppPoolClient extends AdminAppQueryable {
  release(err?: unknown): void;
}

/** Same minimal pool-connect shape as `modules/events/relay-loop.ts`'s `RelayPool` - never `pg`'s own `Pool` type (this repo never imports `pg` directly outside `@wp/db`). */
export interface AdminAppPool {
  connect(): Promise<AdminAppPoolClient>;
}

/** Runs `fn` on one pinned connection under `wp_admin_app` (BYPASSRLS) - READ routes only, see module header. */
export async function withAdminAppRole<T>(
  pool: AdminAppPool,
  fn: (client: AdminAppQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE wp_admin_app');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
        releaseError = undefined;
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    }
  } finally {
    if (releaseError !== undefined) {
      client.release(releaseError as Error);
    } else {
      client.release();
    }
  }
}

/** SHA-256 hex of the canonical `{method, path, body}` JSON - see module header. */
export function computeRequestHash(
  method: string,
  path: string,
  body: Record<string, unknown>,
): string {
  return createHash('sha256').update(JSON.stringify({ method, path, body }), 'utf8').digest('hex');
}
