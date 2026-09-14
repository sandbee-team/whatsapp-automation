import { randomUUID } from 'node:crypto';
import type { PacingQueryable } from './pacing.repo.js';

/**
 * pacing-overrides.repo.ts (P28 Unit U3b, step 5) - the FIRST TypeScript
 * writer of `instance_pacing_overrides` (created by migration 0030 with
 * `wp_app` SELECT/INSERT/UPDATE, extended by migration 0070 with
 * `actor_staff_id`/`expiry_applied_at`, but with no writer until now). A
 * sibling of `pacing.repo.ts` rather than an addition to it, purely for that
 * file's own `max-lines: 300` cap (it sits at 293).
 *
 * ONLY the `kind = 'admin_relax'` half is implemented here - the
 * `tenant_tighten` half stays unwritten until a phase actually needs it, and
 * must not be back-filled speculatively (a tenant-tighten row has a
 * different actor column and a different "may only tighten" validation
 * path).
 *
 * EVERY statement carries `client_id` (core invariant 4). The table has
 * FORCE ROW LEVEL SECURITY with a `client_id = app.client_id` policy, so a
 * missing predicate would silently return/write nothing rather than crossing
 * a tenant boundary - the explicit predicate is belt and braces on top, and
 * is what `scripts/check-tenant-scope.ts` reads.
 *
 * THE STORED `patch` IS ALWAYS THE CLAMPED ONE (never the staff member's raw
 * request): `clampAdminRelax` runs at the route boundary BEFORE this insert,
 * so an operator reading a stored override later sees the numbers that will
 * actually apply. See `packages/domain/src/pacing/relax-bounds.ts`'s own
 * header for why storing an aspirational out-of-bounds value would be wrong
 * even though `resolveEffective()` would clamp it again at resolution time.
 */

export interface InsertAdminRelaxOverrideInput {
  clientId: string;
  instanceId: string;
  /** The CLAMPED patch (see module doc) - never the raw request body. */
  patch: Record<string, number>;
  reason: string;
  actorStaffId: string;
  /** Mandatory and bounded (<= 30 days out) - enforced by `clampAdminRelax` before this call. */
  expiresAt: Date;
}

/** Inserts ONE `admin_relax` override row and returns its id. */
export async function insertAdminRelaxOverride(
  sql: PacingQueryable,
  input: InsertAdminRelaxOverrideInput,
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO instance_pacing_overrides
       (id, client_id, instance_id, kind, patch, reason, actor_staff_id, expires_at)
     VALUES ($1, $2, $3, 'admin_relax', $4::jsonb, $5, $6, $7)
     -- client_id = $2`,
    [
      id,
      input.clientId,
      input.instanceId,
      JSON.stringify(input.patch),
      input.reason,
      input.actorStaffId,
      input.expiresAt,
    ],
  );
  return id;
}

export interface ExpiredAdminRelaxRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  instance_id: string;
}

/**
 * Bounded (`LIMIT $2`) CROSS-TENANT scan for `admin_relax` rows whose
 * `expires_at` has elapsed as of `asOf` and whose expiry has not yet been
 * applied. This is the ONE deliberately non-tenant-scoped statement in this
 * module and is registered in
 * `scripts/registries/cross-tenant-queries-p28.ts`: an expiry sweep has no
 * single tenant to scope to by definition, and it projects only the three
 * ids the caller needs to re-scope each row through `withTenant`.
 *
 * `asOf` IS A PARAMETER, NOT `now()`: the sweep's cutoff has to come from
 * the caller's injected clock, the SAME clock the subsequent
 * `updatePacingConfig` call uses. With a bare `now()` here the two would
 * disagree, and - decisively - a test could only reach the expiry branch by
 * sleeping past a real wall-clock expiry, which is exactly the ambient-state
 * assertion core-invariants forbids. In production the caller passes
 * `new Date(clock.now())`, so behaviour is unchanged.
 *
 * `expiry_applied_at IS NULL` is what makes the sweep idempotent at the
 * STORAGE layer (core invariant 3) rather than via an in-memory "already
 * done" set: a second sweep over the same window selects zero rows.
 */
export async function selectExpiredAdminRelaxOverrides(
  sql: PacingQueryable,
  limit: number,
  asOf: Date,
): Promise<ExpiredAdminRelaxRow[]> {
  const result = await sql.query<ExpiredAdminRelaxRow>(
    `SELECT id::text AS id, client_id::text AS client_id, instance_id::text AS instance_id
       FROM instance_pacing_overrides
      WHERE kind = 'admin_relax'
        AND expires_at IS NOT NULL
        AND expires_at <= $2
        AND expiry_applied_at IS NULL
      ORDER BY expires_at ASC
      LIMIT $1`,
    [limit, asOf],
  );
  return result.rows;
}

/**
 * Stamps `expiry_applied_at` on ONE override row, CONDITIONAL on it still
 * being NULL - returns `true` only for the caller that actually won the
 * stamp, so two concurrent sweeps can never both re-resolve the same row's
 * pacing config.
 */
export async function markAdminRelaxExpiryApplied(
  sql: PacingQueryable,
  input: { clientId: string; overrideId: string },
): Promise<boolean> {
  // `RETURNING id` rather than `rowCount`: `PacingQueryable` (the minimal
  // query port this module shares with `pacing.repo.ts`) exposes only
  // `rows`, so the returned row IS the "did I win the stamp?" signal.
  const result = await sql.query<{ id: string }>(
    `UPDATE instance_pacing_overrides SET expiry_applied_at = now()
      WHERE id = $1 AND client_id = $2 AND expiry_applied_at IS NULL
      RETURNING id
      -- client_id = $2`,
    [input.overrideId, input.clientId],
  );
  return result.rows.length > 0;
}

export interface ActiveAdminRelaxRow extends Record<string, unknown> {
  id: string;
  patch: Record<string, number> | null;
  reason: string | null;
  actor_staff_id: string | null;
  expires_at: Date | null;
}

/** Reads the instance's currently-ACTIVE `admin_relax` override (unexpired, expiry not yet applied), newest first - `undefined` when none applies. */
export async function readActiveAdminRelaxOverride(
  sql: PacingQueryable,
  input: { clientId: string; instanceId: string },
): Promise<ActiveAdminRelaxRow | undefined> {
  const result = await sql.query<ActiveAdminRelaxRow>(
    `SELECT id::text AS id, patch, reason, actor_staff_id::text AS actor_staff_id, expires_at
       FROM instance_pacing_overrides
      WHERE client_id = $1 AND instance_id = $2 AND kind = 'admin_relax'
        AND expiry_applied_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1
      -- client_id = $1`,
    [input.clientId, input.instanceId],
  );
  return result.rows[0];
}

/**
 * P28 C2 FIX (Bug 1): reads the NEWEST still-live `admin_relax` override for
 * this instance as of `asOf` - "live" meaning it has a future `expires_at`
 * AND has not itself been swept (`expiry_applied_at IS NULL`). Used by
 * `admin-relax-expiry.ts` AFTER it stamps one expired row, to discover
 * whether a DIFFERENT override on the SAME instance is still in effect and
 * must be re-folded rather than dropped. `expires_at > $asOf` (strict, and
 * driven by the caller's injected clock - never `now()`, same reasoning as
 * `selectExpiredAdminRelaxOverrides`'s own doc comment) so a row expiring at
 * exactly `asOf` is correctly treated as due, not live.
 */
export async function readNewestLiveAdminRelaxOverride(
  sql: PacingQueryable,
  input: { clientId: string; instanceId: string; asOf: Date },
): Promise<ActiveAdminRelaxRow | undefined> {
  const result = await sql.query<ActiveAdminRelaxRow>(
    `SELECT id::text AS id, patch, reason, actor_staff_id::text AS actor_staff_id, expires_at
       FROM instance_pacing_overrides
      WHERE client_id = $1 AND instance_id = $2 AND kind = 'admin_relax'
        AND expiry_applied_at IS NULL
        AND expires_at > $3
      ORDER BY expires_at DESC
      LIMIT 1
      -- client_id = $1`,
    [input.clientId, input.instanceId, input.asOf],
  );
  return result.rows[0];
}
