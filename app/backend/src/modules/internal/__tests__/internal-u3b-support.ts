import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * internal-u3b-support.ts (P28 Unit U3b, step 5) - the row-level probe READS
 * and seed helpers shared by the four U3b mutation test files
 * (`internal-mutations-{clients,instances,pacing,campaigns}.integration.test.ts`).
 * A sibling of `internal-mutations-support.ts`/`internal-probe-support.ts`
 * rather than an append to either: those two are U3a's frozen surface, and
 * both are already claimed by U3a's own test file.
 *
 * Every query here is scoped to an explicit `client_id`/`instance_id`/
 * `campaign_id` probe value - never a whole-table count, so a parallel run
 * on the shared `wp_test2` database can never observe another file's rows.
 * NOT itself a test file.
 */

export type ProbePool = ReturnType<typeof createPool>;

export async function clientStatus(pool: ProbePool, clientId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM clients WHERE id = $1`, [
    clientId,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`clientStatus: no clients row for ${clientId}`);
  return row.status;
}

export async function setClientStatus(
  pool: ProbePool,
  clientId: string,
  status: string,
): Promise<void> {
  await pool.query(`UPDATE clients SET status = $2, updated_at = now() WHERE id = $1`, [
    clientId,
    status,
  ]);
}

export interface JobSnapshotRow extends Record<string, unknown> {
  id: string;
  status: string;
  attempts: number;
  lease_owner: string | null;
  lease_id: string | null;
  owner_fence: number | null;
  cancel_reason: string | null;
  terminal_at: string | null;
  failed_at: string | null;
  next_attempt_at: string;
}

/**
 * Every `message_jobs` row for `clientId`, ordered by id, as JSON-comparable
 * text - the "byte-identical after a suspend/pause" snapshot for core
 * invariant 5. Projects the columns a lost-work bug would actually move:
 * `status`/`attempts`, the three lease columns a claim would stamp, and the
 * three terminal columns a fail/cancel would stamp.
 */
export async function jobSnapshot(pool: ProbePool, clientId: string): Promise<string> {
  const result = await pool.query<JobSnapshotRow>(
    `SELECT id::text AS id, status, attempts, lease_owner, lease_id::text AS lease_id,
            owner_fence, cancel_reason, terminal_at::text AS terminal_at,
            failed_at::text AS failed_at, next_attempt_at::text AS next_attempt_at
       FROM message_jobs WHERE client_id = $1 ORDER BY id ASC`,
    [clientId],
  );
  return JSON.stringify(result.rows);
}

export async function jobStatusCounts(
  pool: ProbePool,
  clientId: string,
): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM message_jobs WHERE client_id = $1 GROUP BY status`,
    [clientId],
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) counts[row.status] = Number(row.n);
  return counts;
}

export interface StaffAuditActionRow extends Record<string, unknown> {
  action: string;
  target_kind: string | null;
  target_ref: string | null;
}

export async function staffAuditActions(
  pool: ProbePool,
  clientId: string,
): Promise<StaffAuditActionRow[]> {
  const result = await pool.query<StaffAuditActionRow>(
    `SELECT action, target_kind, target_ref FROM staff_audit_log
      WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows;
}

export interface AuditLogProbeRow extends Record<string, unknown> {
  actor_type: string;
  actor_staff_id: string | null;
  action: string;
  target_id: string | null;
}

export async function auditLogRows(pool: ProbePool, clientId: string): Promise<AuditLogProbeRow[]> {
  const result = await pool.query<AuditLogProbeRow>(
    `SELECT actor_type, actor_staff_id, action, target_id::text AS target_id
       FROM audit_logs WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows;
}

export interface InstanceHealthRow extends Record<string, unknown> {
  health_state: string;
  pause_reason: string | null;
  needs_user_action: boolean;
  user_action_reason: string | null;
}

export async function instanceHealth(
  pool: ProbePool,
  clientId: string,
  instanceId: string,
): Promise<InstanceHealthRow> {
  const result = await pool.query<InstanceHealthRow>(
    `SELECT health_state, pause_reason, needs_user_action, user_action_reason
       FROM whatsapp_instances WHERE id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`instanceHealth: no instance ${instanceId} for client ${clientId}`);
  return row;
}

/** Forces `health_state`/`pause_reason` directly, bypassing the app writers - test SETUP only (a fixture is not a second production path; `scripts/check-health-writers.ts` exempts test files). */
export async function forceInstanceState(
  pool: ProbePool,
  input: {
    clientId: string;
    instanceId: string;
    healthState: string;
    pauseReason?: string | null;
  },
): Promise<void> {
  // `$3` is cast explicitly on BOTH uses: without the casts Postgres deduces
  // `health_state`'s enum type from the SET clause and `text` from the CASE
  // comparison, and rejects the statement with "inconsistent types deduced
  // for parameter $3".
  await pool.query(
    `UPDATE whatsapp_instances SET health_state = $3::wa_health,
            pause_reason = $4::pause_reason,
            paused_at = CASE WHEN $3::text = 'paused' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId, input.healthState, input.pauseReason ?? null],
  );
}

/** Seeds one extra `whatsapp_instances` (+ lease + pacing state) row for an already-seeded probe client - the same shape `seedSendTenant` uses for its first instance. */
export async function seedExtraInstance(
  pool: ProbePool,
  clientId: string,
  options: { healthState?: string; deleted?: boolean } = {},
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch, deleted_at)
     VALUES ($1, $2, 'u3b-probe', $3, 0, $4)`,
    [
      instanceId,
      clientId,
      options.healthState ?? 'connected',
      options.deleted === true ? new Date() : null,
    ],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, 1)',
    [instanceId, clientId],
  );
  // Same permissive in-range row `seedSendTenant` writes for its own first
  // instance (see that fixture's own FINDING 6 note on why every value here
  // sits inside the absolute floors/ceilings CHECK constraints).
  await pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, warmup_tier,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, 1, 2000, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
    [instanceId, clientId],
  );
  return instanceId;
}

export async function pacingStateRow(
  pool: ProbePool,
  clientId: string,
  instanceId: string,
): Promise<{ eff_daily_cap: number; eff_gap_min_ms: number }> {
  const result = await pool.query<{ eff_daily_cap: number; eff_gap_min_ms: number }>(
    `SELECT eff_daily_cap, eff_gap_min_ms FROM instance_pacing_state
      WHERE instance_id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`pacingStateRow: no instance_pacing_state for ${instanceId}`);
  return row;
}

export interface PacingOverrideProbeRow extends Record<string, unknown> {
  id: string;
  kind: string;
  patch: Record<string, number> | null;
  actor_staff_id: string | null;
  expires_at: Date | null;
  expiry_applied_at: Date | null;
}

export async function pacingOverrideRows(
  pool: ProbePool,
  clientId: string,
  instanceId: string,
): Promise<PacingOverrideProbeRow[]> {
  const result = await pool.query<PacingOverrideProbeRow>(
    `SELECT id::text AS id, kind, patch, actor_staff_id::text AS actor_staff_id,
            expires_at, expiry_applied_at
       FROM instance_pacing_overrides
      WHERE client_id = $1 AND instance_id = $2 ORDER BY created_at ASC`,
    [clientId, instanceId],
  );
  return result.rows;
}

export async function cleanupU3bRows(pool: ProbePool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM instance_pacing_overrides WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM client_limit_overrides WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM campaign_counters WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [clientIds]);
}
