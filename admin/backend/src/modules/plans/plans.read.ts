import type { AdminReadQueryable } from '../../platform/platform-read.js';

/**
 * modules/plans/plans.read.ts (P28 Unit U4, step 7) - the plan catalogue
 * and one client's effective limits (plan limits plus any staff override).
 *
 * `plans`/`plan_limits` are PLATFORM catalogue tables, not tenant tables -
 * they carry no `client_id` at all, so reading them crosses no tenant
 * boundary. They still go through `platformRead()` like everything else:
 * the audit row is what lets an operator answer "who was looking at what,
 * when" without having to reason about which tables happened to be
 * tenant-scoped.
 *
 * `client_limit_overrides` IS tenant-scoped, and `readClientLimits` reads it
 * for exactly one client, keyed by `client_id` - the narrowest shape a
 * cross-tenant-capable role can use.
 */

export interface PlanItem {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isDefault: boolean;
  maxConnectedInstances: number | null;
  maxRegisteredInstances: number | null;
  maxBroadcastRecipients: number | null;
}

const LIST_PLANS_SQL = `SELECT p.id,
         p.key,
         p.name,
         p.description,
         p.is_default,
         l.max_connected_instances,
         l.max_registered_instances,
         l.max_broadcast_recipients
    FROM plans p
    LEFT JOIN plan_limits l ON l.plan_id = p.id
   ORDER BY p.is_default DESC, p.key NULLS LAST, p.id`;

interface RawPlanRow extends Record<string, unknown> {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  is_default: boolean;
  max_connected_instances: number | null;
  max_registered_instances: number | null;
  max_broadcast_recipients: number | null;
}

/** The whole plan catalogue with its limits - a small, bounded, platform-level table (no pagination needed). */
export async function listPlans(db: AdminReadQueryable): Promise<PlanItem[]> {
  const result = await db.query<RawPlanRow>(LIST_PLANS_SQL);
  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    maxConnectedInstances: row.max_connected_instances,
    maxRegisteredInstances: row.max_registered_instances,
    maxBroadcastRecipients: row.max_broadcast_recipients,
  }));
}

export interface ClientLimitOverrideItem {
  limitKey: string;
  limitValue: number | null;
  expiresAt: string | null;
}

export interface ClientLimitsView {
  plan: {
    key: string | null;
    name: string | null;
    maxConnectedInstances: number | null;
    maxRegisteredInstances: number | null;
    maxBroadcastRecipients: number | null;
  } | null;
  overrides: ClientLimitOverrideItem[];
}

const READ_CLIENT_PLAN_LIMITS_SQL = `SELECT p.key, p.name,
         l.max_connected_instances,
         l.max_registered_instances,
         l.max_broadcast_recipients
    FROM clients c
    JOIN plans p ON p.id = c.plan_id
    LEFT JOIN plan_limits l ON l.plan_id = p.id
   WHERE c.id = $1`;

const READ_CLIENT_OVERRIDES_SQL = `SELECT limit_key, limit_value, expires_at
    FROM client_limit_overrides
   WHERE client_id = $1
   ORDER BY limit_key`;

/**
 * ONE client's effective limit picture: its plan's limits plus every
 * `client_limit_overrides` row. Both halves are returned separately (never
 * pre-merged) so the panel can SHOW that a value is an override rather than
 * the plan default - a merged number would hide the fact that a human
 * widened a limit, which is exactly what a staff reviewer needs to see.
 */
export async function readClientLimits(
  db: AdminReadQueryable,
  clientId: string,
): Promise<ClientLimitsView> {
  const planResult = await db.query<{
    key: string | null;
    name: string;
    max_connected_instances: number | null;
    max_registered_instances: number | null;
    max_broadcast_recipients: number | null;
  }>(READ_CLIENT_PLAN_LIMITS_SQL, [clientId]);
  const planRow = planResult.rows[0];

  const overrideResult = await db.query<{
    limit_key: string;
    limit_value: number | null;
    expires_at: Date | null;
  }>(READ_CLIENT_OVERRIDES_SQL, [clientId]);

  return {
    plan: planRow
      ? {
          key: planRow.key,
          name: planRow.name,
          maxConnectedInstances: planRow.max_connected_instances,
          maxRegisteredInstances: planRow.max_registered_instances,
          maxBroadcastRecipients: planRow.max_broadcast_recipients,
        }
      : null,
    overrides: overrideResult.rows.map((row) => ({
      limitKey: row.limit_key,
      limitValue: row.limit_value,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    })),
  };
}
