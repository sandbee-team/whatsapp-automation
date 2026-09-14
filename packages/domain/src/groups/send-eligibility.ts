import { MAX_TRACKED_PARTICIPANT_DEVICES, DEVICES_PER_PARTICIPANT_ESTIMATE } from './constants.js';

/**
 * send-eligibility.ts (P24 groups-messaging, Unit U2, step 1) - the pure
 * eligibility rules for sending into a group and for enabling group send.
 * Two distinct entry points, deliberately not merged: `canSendToGroup` runs
 * at send/enqueue time (per job), `canEnableGroupSend` runs once at the
 * panel's "turn on sending" toggle - each has a different reason set and a
 * different treatment of a zero daily cap (see `GROUP_CAP_ZERO_AT_TIER`'s own
 * doc below).
 */

export const GROUP_SEND_INELIGIBILITY_REASONS = [
  'NOT_SEND_ENABLED',
  'ANNOUNCE_MEMBER_ONLY',
  'GROUP_CAP_ZERO_AT_TIER',
  'DEVICE_BUDGET_EXCEEDED',
] as const;
export type GroupSendIneligibilityReason = (typeof GROUP_SEND_INELIGIBILITY_REASONS)[number];

/**
 * Reasons that reject at the API with no job row created at all.
 * `GROUP_CAP_ZERO_AT_TIER` is deliberately NOT a member: a cap-zero send
 * still creates a job that defers with `GROUP_DAILY_CAP`, the same "durable
 * job row first" discipline (core invariant 1) every other send path
 * follows. `DEVICE_BUDGET_EXCEEDED` is likewise not a member - it is an
 * enable-time refusal, never seen by `canSendToGroup`'s caller as an
 * API-time rejection reason for an already-enabled group.
 */
export const API_TIME_REJECTION_REASONS: ReadonlySet<GroupSendIneligibilityReason> = new Set([
  'NOT_SEND_ENABLED',
  'ANNOUNCE_MEMBER_ONLY',
]);

export type GroupRole = 'member' | 'admin' | 'superadmin';

export type GroupSendEligibility =
  { sendable: true } | { sendable: false; reason: GroupSendIneligibilityReason };

const ADMIN_ROLES: ReadonlySet<GroupRole> = new Set(['admin', 'superadmin']);

/** True iff `role` is an admin/superadmin - a null role counts as a plain member. */
function isAdminRole(role: GroupRole | null): boolean {
  return role !== null && ADMIN_ROLES.has(role);
}

export interface CanSendToGroupInput {
  sendEnabled: boolean;
  isAnnounce: boolean;
  ourRole: GroupRole | null;
  effGroupDailyCap: number;
  /** Already includes this group's own tracked devices. */
  trackedDevicesInstanceTotal: number;
  groupTrackedDevices: number;
}

/**
 * Send-time eligibility, in order: NOT_SEND_ENABLED -> ANNOUNCE_MEMBER_ONLY
 * -> DEVICE_BUDGET_EXCEEDED -> GROUP_CAP_ZERO_AT_TIER. `groupTrackedDevices`
 * is accepted for shape parity with `canEnableGroupSend` even though
 * `trackedDevicesInstanceTotal` already includes it - callers pass both so
 * neither function silently guesses at the other's derivation.
 */
export function canSendToGroup(input: CanSendToGroupInput): GroupSendEligibility {
  if (!input.sendEnabled) {
    return { sendable: false, reason: 'NOT_SEND_ENABLED' };
  }
  if (input.isAnnounce && !isAdminRole(input.ourRole)) {
    return { sendable: false, reason: 'ANNOUNCE_MEMBER_ONLY' };
  }
  if (input.trackedDevicesInstanceTotal > MAX_TRACKED_PARTICIPANT_DEVICES) {
    return { sendable: false, reason: 'DEVICE_BUDGET_EXCEEDED' };
  }
  if (input.effGroupDailyCap <= 0) {
    return { sendable: false, reason: 'GROUP_CAP_ZERO_AT_TIER' };
  }
  return { sendable: true };
}

export interface CanEnableGroupSendInput {
  isAnnounce: boolean;
  ourRole: GroupRole | null;
  effGroupDailyCap: number;
  trackedDevicesOtherEnabledGroups: number;
  groupTrackedDevices: number;
}

/**
 * Enable-time eligibility: same ANNOUNCE_MEMBER_ONLY rule, but the device
 * budget is computed from `other + this group` (the total AFTER enabling),
 * and a zero daily cap is deliberately NOT a refusal here - the panel still
 * lets the toggle turn on and shows the cap-zero chip instead, because the
 * cap is a warm-up-tier property that changes over time and enabling send
 * now should not require the user to come back and re-enable it later.
 */
export function canEnableGroupSend(input: CanEnableGroupSendInput): GroupSendEligibility {
  if (input.isAnnounce && !isAdminRole(input.ourRole)) {
    return { sendable: false, reason: 'ANNOUNCE_MEMBER_ONLY' };
  }
  const projectedTotal = input.trackedDevicesOtherEnabledGroups + input.groupTrackedDevices;
  if (projectedTotal > MAX_TRACKED_PARTICIPANT_DEVICES) {
    return { sendable: false, reason: 'DEVICE_BUDGET_EXCEEDED' };
  }
  return { sendable: true };
}

/**
 * The ONE conversion between a group's participant count and its estimated
 * tracked-device count - callers never multiply by
 * `DEVICES_PER_PARTICIPANT_ESTIMATE` themselves (a number in a name is not a
 * unit; see core-invariants.md's "Units and quantities" section).
 */
export function deriveTrackedParticipantDevices(participantCount: number): number {
  return Math.max(0, Math.trunc(participantCount)) * DEVICES_PER_PARTICIPANT_ESTIMATE;
}
