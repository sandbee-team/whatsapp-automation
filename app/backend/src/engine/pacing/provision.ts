import type { TenantQueryable } from '@wp/db';

/**
 * provision.ts (P13 Unit U1) - inserts the `instance_pacing_state` row for
 * a newly-created instance, with `eff_*` materialised at warm-up tier 1.
 * SQL-only, no business branching beyond "read tier 1, write eff_* to
 * match it" - same class as `modules/tenancy/provisioning.repo.ts`'s
 * `insertClient`/`insertWalletAccount` functions: one function, one
 * statement (or a small fixed sequence), running against the caller's own
 * transaction handle (`TenantQueryable`), never opening its own connection
 * or transaction.
 *
 * WIRING (not made by this unit - `db/queries/instance-create.sql`'s
 * caller, `app/backend/src/modules/instances/repo.ts#createInstance`, and
 * its own caller `instances.routes.ts`, are both outside this unit's file
 * scope): call `provisionInstancePacingState` with the SAME `client_id`/
 * `instance_id` `createInstance` just inserted, inside the SAME transaction
 * (today `createInstance` runs a single statement against `ctx.sql`, not an
 * explicit multi-statement transaction - P13 Unit U4 must either wrap both
 * calls in one `withTenant`/transaction block, or accept the current
 * "two statements, same connection, no explicit BEGIN" shape if that is
 * this codebase's existing convention for `instances.routes.ts`'s POST
 * handler. Either way, `provisionInstancePacingState` must be called
 * immediately after `repo.createInstance` returns its new `id`, before the
 * route responds success - a created instance with no pacing state row is
 * exactly what `assertNoLiveInstanceIsMissingPacingState` (this file)
 * exists to catch at boot.).
 *
 * AT TIER 1, the materialised eff_* values are the strictest-wins fold of
 * profile ∩ tier1 with health band `healthy` (x1.00 cap, x1.0 gap) and no
 * overrides - i.e. EXACTLY the tier-1 row's own values, plus
 * `eff_cold_ratio_floor` and the window from the profile row.
 * `resolveEffective()` (Unit U2, `packages/domain/src/pacing/resolve-
 * effective.ts`) is the GENERAL path for every later recompute (warm-up
 * advance, band change, override, config change) and does not exist yet -
 * NOT imported and NOT created here. This tier-1 case is provision-time-
 * only special casing and MUST agree with what `resolveEffective()` would
 * compute for a brand-new instance (tier 1, healthy, no overrides) once U2
 * lands - if a future change to this function's tier-1 math and U2's
 * general-case math disagree, that is a bug in one of the two, not a
 * license to diverge.
 */

export interface ProvisionInstancePacingStateInput {
  clientId: string;
  instanceId: string;
  /** Defaults to `'safe_default'` - the system default profile (migration 0031). */
  profileKey?: string;
}

interface Tier1Row extends Record<string, unknown> {
  daily_cap: number;
  hourly_cap: number;
  new_conv_cap: number;
  gap_min_ms: number;
  gap_max_ms: number;
  cold_ratio_max: string;
  group_daily_cap: number;
}

interface ProfileWindowRow extends Record<string, unknown> {
  cold_ratio_floor: number;
  window_start_local: string;
  window_end_local: string;
}

/** Thrown when tier 1 of `profileKey` (or the profile row itself) is missing - never silently skipped (core invariant 2 class: no unclear state proceeds as if it were fine). */
export class PacingProvisionMissingTierError extends Error {
  readonly code = 'pacing_provision_missing_tier' as const;
  constructor(profileKey: string) {
    super(
      `provisionInstancePacingState: profile '${profileKey}' has no tier 1 row in pacing_warmup_tiers, or no matching pacing_profiles row - both must be seeded (migration 0031) before any instance can be provisioned`,
    );
    this.name = 'PacingProvisionMissingTierError';
  }
}

/**
 * Inserts the `instance_pacing_state` row for `input.instanceId`, reading
 * `input.profileKey`'s (default `'safe_default'`) tier-1 row and the
 * profile's window/cold-ratio-floor to materialise `eff_*`. Runs two
 * SELECTs plus one INSERT against `sql` - the caller's own transaction
 * handle - so all three participate in whatever transaction the caller is
 * already inside (see the module doc's WIRING note for why this must run
 * in the same transaction as `createInstance`'s own INSERT).
 */
export async function provisionInstancePacingState(
  sql: TenantQueryable,
  input: ProvisionInstancePacingStateInput,
): Promise<void> {
  const profileKey = input.profileKey ?? 'safe_default';

  const tierResult = await sql.query<Tier1Row>(
    `SELECT daily_cap, hourly_cap, new_conv_cap, gap_min_ms, gap_max_ms,
            cold_ratio_max, group_daily_cap
       FROM pacing_warmup_tiers
      WHERE profile_key = $1 AND tier = 1`,
    [profileKey],
  );
  const tier = tierResult.rows[0];

  const profileResult = await sql.query<ProfileWindowRow>(
    `SELECT cold_ratio_floor, window_start_local, window_end_local
       FROM pacing_profiles
      WHERE key = $1`,
    [profileKey],
  );
  const profile = profileResult.rows[0];

  if (!tier || !profile) {
    throw new PacingProvisionMissingTierError(profileKey);
  }

  await sql.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, profile_key, warmup_tier,
       warmup_started_at, warmup_tier_since,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     )
     VALUES (
       $1, $2, $3, 1,
       now(), now(),
       $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13
     )
     -- client_id = $2
    `,
    [
      input.instanceId,
      input.clientId,
      profileKey,
      tier.daily_cap,
      tier.hourly_cap,
      tier.new_conv_cap,
      tier.gap_min_ms,
      tier.gap_max_ms,
      tier.cold_ratio_max,
      profile.cold_ratio_floor,
      profile.window_start_local,
      profile.window_end_local,
      tier.group_daily_cap,
    ],
  );
}

/**
 * Boot assertion (WIRING: `app/backend/src/platform/db/assert-db-
 * preconditions.ts` is outside this unit's file scope - report the one-line
 * wiring change instead of editing it, same as the provision hook above).
 * Fails (throws) when either:
 *   - a live (`deleted_at IS NULL`) instance has no `instance_pacing_state`
 *     row at all, or
 *   - any live instance's row has a NULL `eff_*` column (should be
 *     impossible given every column is `NOT NULL`, but this is a belt-and-
 *     braces catalog-level check, same fail-closed posture as `assertNoZero
 *     MaxRateWallet`'s "never resolves as if the count were zero" rule).
 * Queries `information_schema`/a plain SELECT under wp_admin_app's BYPASSRLS
 * (same reasoning as `assertNoZeroMaxRateWallet`: a non-BYPASSRLS role with
 * no `app.client_id` GUC set would see zero rows and this gate would
 * silently pass) - callers must pass a BYPASSRLS-connected `Queryable`.
 */
export class PacingStateMissingError extends Error {
  readonly code = 'pacing_state_missing' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PacingStateMissingError';
  }
}

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface OffendingRow extends Record<string, unknown> {
  instance_id: string;
  reason: 'missing_state_row' | 'null_effective_column';
}

/**
 * `instanceIds`, when given, restricts the scan to exactly that set - the
 * injectable-scope pattern this repo's mechanical conventions require for
 * anything that would otherwise assert on ambient database state (same
 * class as `runRamp`'s `readRssBytes?`): the shared dev database carries
 * pre-existing fixture instances (`db/seeds/queue-explain-fixture.sql`)
 * that legitimately have no pacing state, so a test asserting "the WHOLE
 * boot gate is clean" against that shared DB would be sampling ambient
 * fixture state, not a deterministic value. Production boot code calls this
 * with no `instanceIds` (the real, unscoped "every live instance" check);
 * tests pass their own probe instance ids.
 */
export async function assertNoLiveInstanceIsMissingPacingState(
  db: Queryable,
  instanceIds?: readonly string[],
): Promise<void> {
  const result = await db.query<OffendingRow>(
    `SELECT i.id AS instance_id,
            CASE WHEN ips.instance_id IS NULL THEN 'missing_state_row'
                 ELSE 'null_effective_column' END AS reason
       FROM whatsapp_instances i
       LEFT JOIN instance_pacing_state ips ON ips.instance_id = i.id
      WHERE i.deleted_at IS NULL
        AND ($2::uuid[] IS NULL OR i.id = ANY($2))
        AND (
          ips.instance_id IS NULL
          OR ips.eff_daily_cap IS NULL OR ips.eff_hourly_cap IS NULL
          OR ips.eff_new_conv_cap IS NULL OR ips.eff_gap_min_ms IS NULL
          OR ips.eff_gap_max_ms IS NULL OR ips.eff_cold_ratio_max IS NULL
          OR ips.eff_cold_ratio_floor IS NULL
          OR ips.eff_window_start_local IS NULL OR ips.eff_window_end_local IS NULL
        )
      LIMIT $1`,
    [50, instanceIds ?? null],
  );

  if (result.rows.length > 0) {
    const sample = result.rows
      .slice(0, 5)
      .map((row) => `${row.instance_id} (${row.reason})`)
      .join(', ');
    throw new PacingStateMissingError(
      `${result.rows.length} live instance(s) have no instance_pacing_state row or a NULL eff_* column - sample: ${sample}`,
    );
  }
}
