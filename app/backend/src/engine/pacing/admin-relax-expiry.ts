import type { TenantDb } from '@wp/db';
import type { AdminOverride } from '@wp/domain';
import { logger as defaultLogger, type WpLogger } from '@wp/server-kit';
import {
  markAdminRelaxExpiryApplied,
  readNewestLiveAdminRelaxOverride,
  selectExpiredAdminRelaxOverrides,
  type ActiveAdminRelaxRow,
} from '../../modules/pacing/pacing-overrides.repo.js';
import type { PacingQueryable as PacingSweepQueryable } from '../../modules/pacing/pacing.repo.js';
import { loadInstanceLayers } from './admin-relax-layers.js';
import { updatePacingConfig } from './config-service.js';

/**
 * engine/pacing/admin-relax-expiry.ts (P28 Unit U3b, step 5) -
 * `runOneAdminRelaxExpirySweep`, the loop that actually WALKS BACK a staff
 * pacing relax once its mandatory expiry has elapsed.
 *
 * This sweep is the reason a relax is allowed to exist at all: the write
 * path (`modules/internal/routes/pacing.ts`) refuses an override with no
 * expiry or one further than 30 days out, and THIS is what makes that
 * expiry real rather than decorative. Without it, "temporary, reasoned,
 * audited loosening" would be a permanent loosening with a timestamp on it.
 *
 * SHAPE (identical to every other cron sweep in this tree - see
 * `engine/cron/cron-wiring-epoch.ts`'s own header): ONE bounded
 * (`LIMIT maxRows`, default 100) cross-tenant scan per tick, then a
 * per-tenant `withTenant` re-scope for each row found. Cadence never scales
 * with fleet size (ADR 0018 S4), and a single row's failure never aborts the
 * rest of the batch.
 *
 * IDEMPOTENT AT THE STORAGE LAYER (core invariant 3): each row's
 * `expiry_applied_at` stamp is a CONDITIONAL update (`WHERE
 * expiry_applied_at IS NULL`) and is taken BEFORE the config re-resolve, so
 * (a) a second sweep over the same window selects zero rows, and (b) two
 * concurrent sweeps cannot both re-resolve the same instance - only the one
 * that won the stamp proceeds. There is no in-memory "already handled" set.
 *
 * THE RE-RESOLVE STRIPS ONLY THE EXPIRED ROW'S OWN EFFECT (P28 C2 FIX,
 * Bug 1): after stamping the expired row, the sweep looks up whether a
 * DIFFERENT `admin_relax` override on the SAME `(client_id, instance_id)` is
 * still live (`readNewestLiveAdminRelaxOverride`, newest `expires_at` wins)
 * and folds THAT one in as `adminOverride` instead. Only when none is live
 * does it re-resolve with `adminOverride: undefined` - the strict baseline
 * (system profile + warm-up tier + health band) that applies before any
 * relax. A naive unconditional `adminOverride: undefined` here would strip a
 * still-live relax on the same instance the moment ANY other override on
 * that instance expires - exactly the bug this fix closes.
 *
 * SUPERSEDING RULE (also documented here per the fix's own instruction,
 * since the write path has no new column to stamp): when a staff member
 * requests a NEW `admin_relax` override for an instance that already has a
 * live one, this sweep's "newest live `expires_at` wins" rule is what
 * resolves the ambiguity - both rows stay `expiry_applied_at IS NULL` until
 * their own expiry, but `updatePacingConfig`'s own write already re-folds
 * the instance's effective state to the NEW override at request time (see
 * `modules/internal/routes/pacing.ts`), so the newest override is already in
 * effect going forward. No older row is marked `expiry_applied_at` early -
 * that column means "this row's OWN expiry was swept", never "super-
 * seded by a later row" - reusing it for supersession would make a future
 * sweep skip a row whose real expiry has not yet been reached.
 */

const DEFAULT_MAX_ROWS = 100;

/** Rebuilds the `AdminOverride` shape `loadInstanceLayers`/`resolveEffective()` expect from a stored still-live row - see module doc. */
function adminOverrideFromRow(row: ActiveAdminRelaxRow): AdminOverride {
  return {
    ...(row.patch ?? {}),
    actorUserId: row.actor_staff_id ?? '',
    reason: row.reason ?? '',
    expiresAt: row.expires_at ? row.expires_at.getTime() : null,
  };
}

export interface AdminRelaxExpiryDeps {
  /** Pool or any queryable - the cross-tenant SELECT runs here, before any tenant scope. */
  pool: PacingSweepQueryable;
  tenantDb: TenantDb;
  /** Injected so a test can drive the sweep past an `expires_at` without a wall-clock sleep. */
  clock: { now(): number };
  maxRows?: number;
  /** Defaults to `@wp/server-kit`'s shared `logger` - injectable so a test can assert the exact per-row failure log shape without real Postgres (C1 review round 2 MINOR fix: this was previously a silent `catch`). */
  logger?: Pick<WpLogger, 'error'>;
}

export interface AdminRelaxExpirySweepOutcome {
  scanned: number;
  expired: number;
  errors: number;
}

/** Runs ONE bounded admin-relax expiry pass - see module doc for the full contract. */
export async function runOneAdminRelaxExpirySweep(
  deps: AdminRelaxExpiryDeps,
): Promise<AdminRelaxExpirySweepOutcome> {
  // The cutoff comes from the INJECTED clock, the same one the
  // `updatePacingConfig` calls below use (see the repo function's own
  // `asOf` doc comment for why this is a parameter and not `now()`).
  const rows = await selectExpiredAdminRelaxOverrides(
    deps.pool,
    deps.maxRows ?? DEFAULT_MAX_ROWS,
    new Date(deps.clock.now()),
  );

  const log = deps.logger ?? defaultLogger;
  let expired = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const applied = await deps.tenantDb.withTenant(row.client_id, async (tx) => {
        // Stamp FIRST, conditionally - see module doc (this is what makes two
        // concurrent sweeps safe, and what makes a second sweep a no-op).
        const won = await markAdminRelaxExpiryApplied(tx, {
          clientId: row.client_id,
          overrideId: row.id,
        });
        if (!won) return false;

        const stillLive = await readNewestLiveAdminRelaxOverride(tx, {
          clientId: row.client_id,
          instanceId: row.instance_id,
          asOf: new Date(deps.clock.now()),
        });

        const layers = await loadInstanceLayers(tx, {
          clientId: row.client_id,
          instanceId: row.instance_id,
          adminOverride: stillLive ? adminOverrideFromRow(stillLive) : undefined,
        });

        await updatePacingConfig({
          sql: tx,
          clientId: row.client_id,
          instanceId: row.instance_id,
          kind: 'admin_relax',
          reason: 'admin_relax_expired',
          layers,
          clock: deps.clock,
        });
        return true;
      });
      if (applied) expired += 1;
    } catch (err) {
      // A single override's failure never aborts the batch - same
      // per-tenant try/catch every other cross-tenant sweep in this tree
      // uses. The row keeps `expiry_applied_at IS NULL` only if the whole
      // transaction rolled back, so the next tick retries it. Logged (never
      // silent, C1 review round 2 MINOR fix) so an operator can see WHICH
      // override/instance is stuck retrying every tick. Fields are
      // `client_id`/`instance_id`/`error_class` (`@wp/server-kit`'s
      // `LogFields` allow-list has no `overrideId` field - same idiom as
      // `warmup-evaluator.ts`'s own per-row catch): the override id and the
      // error message are folded into the log MESSAGE string instead.
      const message = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.name : 'unknown';
      log.error(
        { client_id: row.client_id, instance_id: row.instance_id, error_class: errorClass },
        `admin-relax-expiry sweep: override ${row.id} failed to re-resolve: ${message}`,
      );
      errors += 1;
    }
  }

  return { scanned: rows.length, expired, errors };
}
