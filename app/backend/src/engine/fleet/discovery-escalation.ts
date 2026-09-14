import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { notify } from '../../modules/notifications/index.js';

/**
 * discovery-escalation.ts (FIX-P09-B split) - the escalation write section
 * (3-consecutive-cycle unowned+ungrabbed -> degraded +
 * needs_user_action='INFRA_UNAVAILABLE') and the ownership-freshness
 * re-check, mechanically extracted out of `discovery.ts` for the max-lines
 * cap. `discovery.ts` still imports this module (keeping it covered by the
 * placement-neutrality/shutdown-purity guards) and re-exports every symbol
 * so existing import paths keep working unchanged. No logic change.
 *
 * Client-scoped, conditional, idempotent
 * (instance-mark-infra-unavailable.sql's own header comment).
 */

interface MarkInfraUnavailableRow extends Record<string, unknown> {
  id: string;
}

/**
 * Runs `instance-mark-infra-unavailable.sql` then, ONLY if the row actually
 * changed (the changed-flag pattern: `RETURNING id` non-empty), writes ONE
 * `audit_logs` row in the same client scope. Deliberately a direct, narrow
 * `INSERT INTO audit_logs` here (not `modules/tenancy`'s `insertAuditLog`,
 * the P08 writer `service.ts`'s own transition-audit calls use) - importing
 * `modules/tenancy/index.js`'s barrel would also pull in
 * `onboarding.routes.js` -> `platform/http/**` -> `@wp/server-kit`'s
 * config-parsing `logger` singleton, which throws `ConfigError` outside a
 * `WP_ENV`-carrying test env (only `app/backend/vitest.config.ts`'s
 * `*.integration.test.ts` project sets those - this module's own PLAIN unit
 * tests would break). A direct deep import of
 * `modules/tenancy/provisioning.repo.js` is exactly the cross-module reach
 * the `no-deep-module-import` dependency-cruiser rule forbids, so this
 * inlines the same narrow shape instead (same table, same column set, same
 * allow-listed metadata keys `reason`/`code` per that module's
 * `ALLOWED_AUDIT_METADATA_KEYS`).
 *
 * Zero-effect (no audit row) if already degraded+INFRA_UNAVAILABLE, if the
 * instance was re-owned/transitioned meanwhile, or if it was deleted
 * meanwhile. Touches ZERO `message_jobs` rows (core invariant 5) - this
 * statement's UPDATE target is `whatsapp_instances` only, and the audit
 * insert targets `audit_logs` only.
 */
interface LeaseSeenAtRow extends Record<string, unknown> {
  fresh: boolean;
}

/**
 * WARNING FIX 5 - tenant-scoped freshness check: `true` when
 * `instance_lease_state.lease_seen_at` for this instance is fresh (someone
 * currently owns/renews it), i.e. NOT what the discovery scan's own
 * `staleMs` window would treat as unowned. Used to re-verify ownership
 * BEFORE counting a cycle toward (or escalating) the `INFRA_UNAVAILABLE`
 * streak - a cycle that only ever lost the GRAB RACE (another worker holds
 * a fresh lease) must never be indistinguishable from a genuinely unowned
 * instance.
 *
 * Deliberately tenant-scoped (via the caller's own `tx: TenantQueryable`,
 * the SAME `withTenant(row.clientId, ...)` pattern `markInfraUnavailable`
 * already uses) rather than a new cross-tenant query - no
 * `cross-tenant-queries.ts` registration needed, since this predicate
 * carries `client_id` in the same statement.
 */
export async function isInstanceOwnershipFresh(
  sql: TenantQueryable,
  input: { instanceId: string; clientId: string; staleMs: number },
): Promise<boolean> {
  const result = await sql.query<LeaseSeenAtRow>(
    `SELECT (lease_seen_at IS NOT NULL AND lease_seen_at >= now() - make_interval(secs => $3 / 1000.0)) AS fresh
       FROM instance_lease_state
      WHERE instance_id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId, input.staleMs],
  );
  return result.rows[0]?.fresh === true;
}

export async function markInfraUnavailableIfChanged(
  sql: TenantQueryable,
  input: { instanceId: string; clientId: string },
): Promise<boolean> {
  const query = await loadQuery('instance-mark-infra-unavailable');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: input.clientId,
  });
  const result = await sql.query<MarkInfraUnavailableRow>(query.text, params);
  const changed = result.rows.length > 0;
  if (!changed) {
    return false;
  }

  const auditResult = await sql.query<{ id: string }>(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.clientId,
      'system',
      null,
      'instance.degraded',
      'instance',
      input.instanceId,
      JSON.stringify({ reason: 'INFRA_UNAVAILABLE', code: null }),
    ],
  );

  // P17 U6 (step 5) - infra_unavailable: mandatory notify on the SAME tx,
  // only on this actual-transition branch (the zero-effect no-op path
  // already returned above). transitionId = the audit_logs row this
  // statement just wrote (RETURNING id, added above) - stable, non-wall-
  // clock, and unique per real escalation occurrence.
  const auditId = auditResult.rows[0]?.id;
  if (auditId) {
    await notify(sql, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      kind: 'infra_unavailable',
      transitionId: auditId,
      payload: { instanceId: input.instanceId },
      requiresUserAction: true,
    });
  }

  return true;
}
