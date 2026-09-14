import type { createPool } from '@wp/db';

/**
 * p28-staff-demo-probes.ts (P28, step 10) - the two row-level probe queries
 * `p28-staff-demo.ts` needs beyond what `internal-probe-support.ts` already
 * exposes (that fixture's own `auditRows`/`notificationKinds` intentionally
 * omit `reason`/`idempotency_key` and the full notification row shape for
 * the gate tests' own, narrower needs). Split out of the demo script itself
 * purely for the `max-lines: 300` cap (same split idiom as
 * `session-worker-discovery-wiring.ts`) - NOT a test file, not imported by
 * any shipped runtime code.
 */

export interface DemoAuditRow extends Record<string, unknown> {
  id: string;
  staff_id: string;
  action: string;
  client_id: string | null;
  target_kind: string | null;
  target_ref: string | null;
  reason: string;
  idempotency_key: string;
  result: string;
  created_at: string;
}

/** The exact `staff_audit_log` projection the phase's evidence doc asks for (section 5 of `docs/evidence/P28-admin-grants-and-audit.md`). */
export async function demoAuditRows(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<DemoAuditRow[]> {
  const result = await pool.query<DemoAuditRow>(
    `SELECT id::text AS id, staff_id::text AS staff_id, action, client_id::text AS client_id,
            target_kind, target_ref, reason, idempotency_key, result::text AS result,
            created_at::text AS created_at
       FROM staff_audit_log WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows;
}

export interface DemoNotificationRow extends Record<string, unknown> {
  id: string;
  kind: string;
  severity: string;
  instance_id: string | null;
  dedupe_key: string;
  created_at: string;
}

/** The exact `notifications` projection the evidence doc asks for - ids/enums only, NO payload text. */
export async function demoNotificationRows(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<DemoNotificationRow[]> {
  const result = await pool.query<DemoNotificationRow>(
    `SELECT id::text AS id, kind, severity, instance_id::text AS instance_id, dedupe_key,
            created_at::text AS created_at
       FROM notifications WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows;
}
