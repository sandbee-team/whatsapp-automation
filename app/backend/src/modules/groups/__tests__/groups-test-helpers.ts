import type { createPool } from '@wp/db';

type Pool = ReturnType<typeof createPool>;

/**
 * modules/groups/__tests__/groups-test-helpers.ts (P24) - the ONE shared seed
 * for `wa_groups` rows in integration tests. Pre-created by the orchestrating
 * session so the three parallel W3 units (U3 routes/sync, U4a send path, U4b
 * forbidden/receipts) never share a file. Lives under `__tests__/` so the
 * raw INSERT/DELETE below fall under `scripts/check-tenant-scope.ts`'s
 * seed/cleanup exemption (same reason `engine/pacing/__tests__/
 * pacing-test-helpers.ts` lives where it does).
 *
 * Synthetic ids only: `1203630000000000NNN@g.us` is not a real group. No
 * participant identity is ever seeded - the table stores COUNTS ONLY.
 */

export interface SeedWaGroupOptions {
  clientId: string;
  instanceId: string;
  /** Defaults to a synthetic `12036300000000000001@g.us`-style jid; pass an explicit one to seed several groups. */
  groupJid?: string;
  subject?: string | null;
  participantCount?: number | null;
  isAnnounce?: boolean;
  ourRole?: 'member' | 'admin' | 'superadmin' | null;
  sendEnabled?: boolean;
  sendEnabledByUserId?: string | null;
  disabledReason?: string | null;
  trackedParticipantDevices?: number;
  nextSyncAfter?: Date | null;
  leaveRequestedAt?: Date | null;
  leftAt?: Date | null;
  lastSyncedAt?: Date | null;
}

export interface SeededWaGroup {
  id: string;
  groupJid: string;
}

let seedCounter = 0;

/** Returns a fresh synthetic group jid - never a real WhatsApp group id. */
export function syntheticGroupJid(): string {
  seedCounter += 1;
  return `120363${String(seedCounter).padStart(14, '0')}@g.us`;
}

export async function seedWaGroup(pool: Pool, options: SeedWaGroupOptions): Promise<SeededWaGroup> {
  const groupJid = options.groupJid ?? syntheticGroupJid();
  const sendEnabled = options.sendEnabled ?? false;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO wa_groups
       (client_id, instance_id, group_jid, subject, participant_count, is_announce, our_role,
        send_enabled, send_enabled_at, send_enabled_by_user_id, disabled_reason,
        tracked_participant_devices, next_sync_after, leave_requested_at, left_at, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 THEN now() END, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      options.clientId,
      options.instanceId,
      groupJid,
      options.subject ?? 'synthetic group',
      options.participantCount ?? 10,
      options.isAnnounce ?? false,
      options.ourRole ?? 'member',
      sendEnabled,
      options.sendEnabledByUserId ?? null,
      options.disabledReason ?? null,
      options.trackedParticipantDevices ?? (options.participantCount ?? 10) * 2,
      options.nextSyncAfter ?? null,
      options.leaveRequestedAt ?? null,
      options.leftAt ?? null,
      options.lastSyncedAt ?? null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error('seedWaGroup: INSERT returned no row');
  }
  return { id: row.id, groupJid };
}

export interface WaGroupStateRow {
  id: string;
  send_enabled: boolean;
  disabled_reason: string | null;
  next_sync_after: Date | null;
  leave_requested_at: Date | null;
  left_at: Date | null;
  participant_count: number | null;
  tracked_participant_devices: number;
  last_message_at: Date | null;
}

/** Test-only read of the columns the P24 tests assert on (raw pool, bypasses RLS on purpose). */
export async function readWaGroupState(
  pool: Pool,
  groupId: string,
): Promise<WaGroupStateRow | undefined> {
  const { rows } = await pool.query<WaGroupStateRow>(
    `SELECT id, send_enabled, disabled_reason, next_sync_after, leave_requested_at, left_at,
            participant_count, tracked_participant_devices, last_message_at
       FROM wa_groups WHERE id = $1`,
    [groupId],
  );
  return rows[0];
}

/** Deletes every `wa_groups` row of the given probe clients (call from afterEach, before the tenant cleanup). */
export async function cleanupWaGroups(
  pool: Pool,
  probeClientIds: readonly string[],
): Promise<void> {
  if (probeClientIds.length === 0) {
    return;
  }
  await pool.query('DELETE FROM wa_groups WHERE client_id = ANY($1::uuid[])', [probeClientIds]);
}
