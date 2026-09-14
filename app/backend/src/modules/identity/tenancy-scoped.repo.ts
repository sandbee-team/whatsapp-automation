import type { TenantQueryable } from '@wp/db';

/**
 * tenancy-scoped.repo.ts (P04a FIXD, split out of identity.repo.ts for
 * max-lines) - every identity.repo.ts function that resolves or sets a
 * `client_id`/`app.client_id` GUC: client-id resolution, the lockout audit
 * write, onboarding-step advancement, and the self-scoping `/v1/auth/me`
 * read (`getMeForUser`). Pure code motion: no behavior change from the
 * original identity.repo.ts, including transaction boundaries.
 */

/**
 * Resolves the `client_id` a user belongs to, for the lockout audit write
 * (login.service.ts) - login has no established tenant context yet (no
 * `app.client_id` GUC set), so this calls `public.wp_client_id_for_user`
 * (migration 0015), a SECURITY DEFINER function owned by `wp_admin_app`
 * (BYPASSRLS) - a plain SELECT of client_id straight off the memberships
 * table, run as wp_app with no GUC set, would be filtered to zero rows by
 * `memberships`' `tenant_isolation` policy (FIX 1, P04a FIXA C1 review) and
 * silently return `null` for every real user. `memberships_one_workspace_
 * per_user_uq` (migration 0002) guarantees at most one row/one true answer,
 * which is exactly what the definer function itself relies on (`LIMIT 1`).
 */
export async function findClientIdForUser(
  sql: TenantQueryable,
  userId: string,
): Promise<string | null> {
  const result = await sql.query<{ wp_client_id_for_user: string | null }>(
    `SELECT public.wp_client_id_for_user($1) AS wp_client_id_for_user`,
    [userId],
  );
  return result.rows[0]?.wp_client_id_for_user ?? null;
}

/**
 * Sets the transaction-local `app.client_id` GUC (FIX 1, P04a FIXA C1
 * review) - the same `set_config(..., true)` primitive that @wp/db uses
 * inside `TenantDb.withTenant`, applied manually here because login/session/
 * verify-email run their OWN BEGIN/COMMIT against a plain connection (see
 * identity.repo.ts's header comment) rather than `withTenant`, and only need
 * the GUC set for the PART of their transaction that touches an
 * RLS-protected tenant table (`memberships`, `audit_logs`, `clients`) -
 * never for the `users`/`auth_sessions` reads/writes, which carry no RLS at
 * all.
 */
export async function setAppClientId(sql: TenantQueryable, clientId: string): Promise<void> {
  await sql.query(`SELECT set_config('app.client_id', $1, true)`, [clientId]);
}

export interface InsertLockoutAuditLogInput {
  userId: string;
  /** `null` when the user's client could not be resolved - audit_logs.client_id is nullable by design (migration 0013). */
  clientId: string | null;
}

/** Inserts the one `audit_logs` row (action `'auth.lockout'`) an entering-lockout write requires. */
export async function insertLockoutAuditLog(
  sql: TenantQueryable,
  input: InsertLockoutAuditLogInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id)
     VALUES ($1, 'system', 'auth.lockout', 'user', $2)`,
    [input.clientId, input.userId],
  );
}

/**
 * Advances `clientId` from `verify_email` to `choose_timezone` - conditional
 * on the current step still being `verify_email` (monotonic-safe against a
 * replay or an already-advanced client). The full onboarding step machine is
 * a later session's work; this is only the one step this unit owns.
 *
 * FIX 1 (P04a FIXA C1 review): takes the ALREADY-RESOLVED `clientId` (via
 * `findClientIdForUser`/`wp_client_id_for_user`) rather than re-deriving it
 * from `memberships` here - the caller sets the `app.client_id` GUC
 * (`setAppClientId`) to this same value first, which is what lets this
 * UPDATE satisfy the clients tenant_isolation policy under wp_app.
 * Returns whether a row was actually updated - see getClientOnboardingStep
 * for the already-past-verify_email-vs-unexpectedly-zero-rows
 * disambiguation the caller needs to run.
 */
export async function advanceOnboardingStepAfterEmailVerification(
  sql: TenantQueryable,
  clientId: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET onboarding_step = 'choose_timezone'
      WHERE id = $1
        AND onboarding_step = 'verify_email'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows.length > 0;
}

/**
 * P04b Unit UB1a, task 5: activates `clientId` (`pending_verification` ->
 * `active`) - conditional on the CURRENT status still being
 * `pending_verification`, so a `suspended`/`closed` client is NEVER
 * resurrected by a verify-email link (fail-safe, core invariant 2). Same
 * caller/GUC precondition as `advanceOnboardingStepAfterEmailVerification`
 * above (the caller has already resolved `clientId` and set the
 * `app.client_id` GUC to it). Returns whether a row was actually updated -
 * `false` covers BOTH "already active" (benign replay) and "suspended/
 * closed" (the fail-safe denial) equally; the caller does not need to
 * distinguish them further, only never treat a zero-row result as failure.
 */
export async function activateClientIfPending(
  sql: TenantQueryable,
  clientId: string,
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `UPDATE clients SET status = 'active'
      WHERE id = $1
        AND status = 'pending_verification'
      RETURNING id
      -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows.length > 0;
}

/**
 * Reads the CURRENT `onboarding_step` for `clientId` - used ONLY to
 * disambiguate a zero-row `advanceOnboardingStepAfterEmailVerification`
 * result (FIX 1, P04a FIXA C1 review): already past `verify_email` is a
 * benign no-op (idempotent replay), anything else (client not found, or
 * still on `verify_email` despite the conditional UPDATE matching nothing)
 * is an unexpected failure the caller must throw on rather than silently
 * swallow.
 */
export async function getClientOnboardingStep(
  sql: TenantQueryable,
  clientId: string,
): Promise<string | null> {
  const result = await sql.query<{ onboarding_step: string }>(
    `SELECT onboarding_step FROM clients WHERE id = $1
     -- client_id = id = $1
    `,
    [clientId],
  );
  return result.rows[0]?.onboarding_step ?? null;
}

export interface BasicUser {
  id: string;
  email: string;
  fullName: string;
}

/**
 * M20a (P04a FIXB) - promoted from identity.routes.ts, which used to run
 * this SQL inline. Returns `null` when no such user exists - the caller
 * decides how to map that.
 */
export async function fetchBasicUser(
  sql: TenantQueryable,
  userId: string,
): Promise<BasicUser | null> {
  const result = await sql.query<{ id: string; email: string; full_name: string }>(
    'SELECT id, email, full_name FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, fullName: row.full_name };
}

export interface MeRow {
  user: {
    id: string;
    email: string;
    fullName: string;
    emailVerifiedAt: string | null;
    mfaEnabledAt: string | null;
  };
  client: { id: string; companyName: string; onboardingStep: string; status: string };
  membership: { role: string };
}

/** Returns `null` when no such user/membership/client trio exists. */
export async function fetchMeRow(sql: TenantQueryable, userId: string): Promise<MeRow | null> {
  const result = await sql.query<{
    user_id: string;
    email: string;
    full_name: string;
    email_verified_at: Date | null;
    mfa_enabled_at: Date | null;
    client_id: string;
    company_name: string;
    onboarding_step: string;
    status: string;
    role: string;
  }>(
    `SELECT u.id AS user_id, u.email, u.full_name, u.email_verified_at, u.mfa_enabled_at,
            c.id AS client_id, c.company_name, c.onboarding_step, c.status,
            m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN clients c ON c.id = m.client_id
      WHERE u.id = $1
      LIMIT 1
      -- client_id = m.client_id (memberships_one_workspace_per_user_uq
      -- guarantees at most one row per user, so this is scoped to exactly
      -- the one client resolved from the requesting membership row - same
      -- pattern as findMembershipForUser)
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
      mfaEnabledAt: row.mfa_enabled_at ? row.mfa_enabled_at.toISOString() : null,
    },
    client: {
      id: row.client_id,
      companyName: row.company_name,
      onboardingStep: row.onboarding_step,
      status: row.status,
    },
    membership: { role: row.role },
  };
}

export interface MeDbClient extends TenantQueryable {
  release(err?: unknown): void;
}

export interface MeDbPool {
  connect(): Promise<MeDbClient>;
}

/**
 * FIX 13 (P04a FIXC, CRITICAL): `fetchMeRow` above joins `memberships`/
 * `clients` (both FORCE RLS, `tenant_isolation` policy) - called on a bare
 * pool connection with no `app.client_id` GUC set (as `identity.routes.ts`
 * used to do directly), that join is filtered to ZERO rows under `wp_app`
 * and `/v1/auth/me` 401s for every real user. This is the ONLY sanctioned,
 * self-scoping way to read it: open one transaction, resolve the caller's
 * OWN `client_id` via `findClientIdForUser` (a SECURITY DEFINER function -
 * works with no GUC set, same precedent as session.service.ts's
 * `resolveMembershipOrThrow`/login.service.ts's lockout-audit write), set
 * the `app.client_id` GUC (`setAppClientId`), THEN run `fetchMeRow` - all on
 * the SAME connection, so the GUC is visible to the join. Deliberately NOT
 * "SQL only" like the rest of identity.repo.ts (see that file's header
 * comment) - this is the one exception, and it exists precisely so
 * `identity.routes.ts` never has to run `fetchMeRow` on a bare pool again.
 */
export async function getMeForUser(pool: MeDbPool, userId: string): Promise<MeRow | null> {
  const client = await pool.connect();
  try {
    // P04b Unit UB1a: this transaction only ever reads (`findClientIdForUser`,
    // `fetchMeRow`) - `BEGIN READ ONLY` makes that a hard guarantee at the
    // database level, not just a convention.
    await client.query('BEGIN READ ONLY');
    const clientId = await findClientIdForUser(client, userId);
    if (!clientId) {
      await client.query('ROLLBACK');
      return null;
    }
    await setAppClientId(client, clientId);
    const row = await fetchMeRow(client, userId);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is what must propagate, not a rollback failure.
    }
    throw err;
  } finally {
    client.release();
  }
}
