import { describe, expect, it } from 'vitest';
import {
  canSendToGroup,
  canEnableGroupSend,
  deriveTrackedParticipantDevices,
  API_TIME_REJECTION_REASONS,
} from './send-eligibility.js';
import { MAX_TRACKED_PARTICIPANT_DEVICES } from './constants.js';

/**
 * send-eligibility.test.ts (P24 groups-messaging, Unit U2, step 1).
 */

const BASE_SEND_INPUT = {
  sendEnabled: true,
  isAnnounce: false,
  ourRole: 'member' as const,
  effGroupDailyCap: 100,
  trackedDevicesInstanceTotal: 10,
  groupTrackedDevices: 10,
};

describe('an_announce_group_where_we_are_a_member_is_not_sendable', () => {
  it('member_role_in_an_announce_group_is_refused', () => {
    const result = canSendToGroup({ ...BASE_SEND_INPUT, isAnnounce: true, ourRole: 'member' });
    expect(result).toEqual({ sendable: false, reason: 'ANNOUNCE_MEMBER_ONLY' });
  });

  it('a_null_role_counts_as_member_and_is_refused', () => {
    const result = canSendToGroup({ ...BASE_SEND_INPUT, isAnnounce: true, ourRole: null });
    expect(result).toEqual({ sendable: false, reason: 'ANNOUNCE_MEMBER_ONLY' });
  });

  it('admin_role_in_an_announce_group_is_sendable', () => {
    const result = canSendToGroup({ ...BASE_SEND_INPUT, isAnnounce: true, ourRole: 'admin' });
    expect(result).toEqual({ sendable: true });
  });

  it('superadmin_role_in_an_announce_group_is_sendable', () => {
    const result = canSendToGroup({ ...BASE_SEND_INPUT, isAnnounce: true, ourRole: 'superadmin' });
    expect(result).toEqual({ sendable: true });
  });
});

describe('enabling_send_beyond_the_two_thousand_device_budget_is_refused', () => {
  it('exactly_at_the_budget_is_allowed', () => {
    expect(MAX_TRACKED_PARTICIPANT_DEVICES).toBe(2000);
    const result = canEnableGroupSend({
      isAnnounce: false,
      ourRole: 'member',
      effGroupDailyCap: 100,
      trackedDevicesOtherEnabledGroups: 1990,
      groupTrackedDevices: 10,
    });
    expect(result).toEqual({ sendable: true });
  });

  it('one_device_over_the_budget_is_refused_as_the_2001st_device', () => {
    const result = canEnableGroupSend({
      isAnnounce: false,
      ourRole: 'member',
      effGroupDailyCap: 100,
      trackedDevicesOtherEnabledGroups: 1990,
      groupTrackedDevices: 11,
    });
    expect(result).toEqual({ sendable: false, reason: 'DEVICE_BUDGET_EXCEEDED' });
  });
});

describe('cap_zero_is_not_an_api_time_rejection', () => {
  it('cap_zero_at_send_time_defers_rather_than_api_rejects', () => {
    const result = canSendToGroup({ ...BASE_SEND_INPUT, effGroupDailyCap: 0 });
    expect(result).toEqual({ sendable: false, reason: 'GROUP_CAP_ZERO_AT_TIER' });
    expect(result.sendable).toBe(false);
    if (!result.sendable) {
      expect(API_TIME_REJECTION_REASONS.has(result.reason)).toBe(false);
    }
  });

  it('cap_zero_at_enable_time_is_not_a_refusal', () => {
    const result = canEnableGroupSend({
      isAnnounce: false,
      ourRole: 'member',
      effGroupDailyCap: 0,
      trackedDevicesOtherEnabledGroups: 0,
      groupTrackedDevices: 10,
    });
    expect(result).toEqual({ sendable: true });
  });
});

describe('derive_tracked_devices_is_exact', () => {
  it('multiplies_by_the_devices_per_participant_estimate_and_truncates', () => {
    expect(deriveTrackedParticipantDevices(184)).toBe(368);
    expect(deriveTrackedParticipantDevices(0)).toBe(0);
    expect(deriveTrackedParticipantDevices(7.9)).toBe(14);
  });
});

describe('canSendToGroup precedence order', () => {
  it('not_send_enabled_wins_over_every_other_reason', () => {
    const result = canSendToGroup({
      ...BASE_SEND_INPUT,
      sendEnabled: false,
      isAnnounce: true,
      ourRole: 'member',
      effGroupDailyCap: 0,
    });
    expect(result).toEqual({ sendable: false, reason: 'NOT_SEND_ENABLED' });
  });

  it('device_budget_exceeded_wins_over_cap_zero', () => {
    const result = canSendToGroup({
      ...BASE_SEND_INPUT,
      trackedDevicesInstanceTotal: MAX_TRACKED_PARTICIPANT_DEVICES + 1,
      effGroupDailyCap: 0,
    });
    expect(result).toEqual({ sendable: false, reason: 'DEVICE_BUDGET_EXCEEDED' });
  });
});
