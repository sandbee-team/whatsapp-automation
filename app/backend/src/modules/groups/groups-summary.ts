import type { GroupSendEligibility } from '@wp/domain';
import type { GroupSummary } from '@wp/contracts';
import type { GroupRow } from './groups.repo.js';

/**
 * groups-summary.ts (P24 C2 fix round, Fix 1) - the `GroupRow` -> `GroupSummary`
 * projection shared by `groups.service.ts` (list) and
 * `groups-send-enabled.service.ts` (enable/disable), split out so neither
 * file needs to import the other (avoiding a cycle) and so extracting
 * `setGroupSendEnabled` did not require duplicating this mapping.
 */

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Normalises the domain's discriminated-union `GroupSendEligibility` (whose `sendable: true` branch omits `reason` entirely) into the contract's always-both-fields shape (`reason` nullable, never absent). */
export function toEligibility(eligibility: GroupSendEligibility): GroupSummary['eligibility'] {
  return eligibility.sendable
    ? { sendable: true, reason: null }
    : { sendable: false, reason: eligibility.reason };
}

export function toGroupSummary(
  row: GroupRow,
  eligibility: GroupSummary['eligibility'],
): GroupSummary {
  return {
    id: row.id,
    instanceId: row.instance_id,
    subject: row.subject,
    participantCount: row.participant_count,
    isAnnounce: row.is_announce,
    ourRole: row.our_role,
    sendEnabled: row.send_enabled,
    sendEnabledAt: toIso(row.send_enabled_at),
    disabledReason: row.disabled_reason,
    trackedParticipantDevices: row.tracked_participant_devices,
    lastSyncedAt: toIso(row.last_synced_at),
    lastMessageAt: toIso(row.last_message_at),
    leaveRequestedAt: toIso(row.leave_requested_at),
    eligibility,
  };
}

export { toIso };
