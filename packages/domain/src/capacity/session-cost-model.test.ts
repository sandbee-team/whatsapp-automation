import { describe, expect, it } from 'vitest';
import {
  composeSessionMb,
  exceedsRedesignThreshold,
  groupStateMb,
  InvalidRecordSizeError,
  InvalidTrackedDevicesError,
} from './session-cost-model.js';

describe('group state mb', () => {
  it('group_state_is_devices_times_record_size_not_a_flat_megabyte', () => {
    // 184-participant group, ~1.2 devices/participant average -> ~220
    // tracked devices, at a measured 12 KB/record.
    const recordKb = 12;
    const trackedDevices184 = 220;

    const mb184 = groupStateMb({ trackedDevices: trackedDevices184, recordKb });
    expect(mb184).toBeCloseTo((trackedDevices184 * recordKb) / 1024, 6);
    expect(mb184).not.toBeCloseTo(1, 1); // never the flat "1 MB" figure

    // Linearity: doubling tracked devices must double the modelled MB.
    const doubled = groupStateMb({ trackedDevices: trackedDevices184 * 2, recordKb });
    expect(doubled).toBeCloseTo(mb184 * 2, 6);

    // A small group must model to proportionally less, not clamp to 1 MB.
    const small = groupStateMb({ trackedDevices: 10, recordKb });
    expect(small).toBeCloseTo((10 * recordKb) / 1024, 6);
    expect(small).toBeLessThan(mb184);
  });

  it('rejects_zero_or_negative_record_size', () => {
    expect(() => groupStateMb({ trackedDevices: 10, recordKb: 0 })).toThrow(InvalidRecordSizeError);
    expect(() => groupStateMb({ trackedDevices: 10, recordKb: -5 })).toThrow(
      InvalidRecordSizeError,
    );
  });

  it('rejects_negative_tracked_devices', () => {
    expect(() => groupStateMb({ trackedDevices: -1, recordKb: 12 })).toThrow(
      InvalidTrackedDevicesError,
    );
  });

  it('zero_tracked_devices_is_valid_and_returns_zero_mb', () => {
    expect(groupStateMb({ trackedDevices: 0, recordKb: 12 })).toBe(0);
  });

  it('accepts_fractional_record_kb', () => {
    const mb = groupStateMb({ trackedDevices: 10, recordKb: 0.5 });
    expect(mb).toBeCloseTo((10 * 0.5) / 1024, 10);
  });

  it('accepts_the_adr_0018_2000_device_cap_and_beyond', () => {
    const atCap = groupStateMb({ trackedDevices: 2000, recordKb: 12 });
    expect(atCap).toBeCloseTo((2000 * 12) / 1024, 6);

    const beyondCap = groupStateMb({ trackedDevices: 5000, recordKb: 12 });
    expect(beyondCap).toBeCloseTo((5000 * 12) / 1024, 6);
    expect(beyondCap).toBeGreaterThan(atCap);
  });
});

describe('composeSessionMb profiles', () => {
  const baseInput = {
    socketSlopeMb: 20,
    signalMbPerContact: 0.01,
    contacts: 200,
    recordKb: 12,
  };

  it('group_enabled_profile_can_never_return_the_dm_only_figure', () => {
    const fixtures = [
      { ...baseInput, groupDevices: 0 },
      { ...baseInput, groupDevices: 1 },
      { ...baseInput, groupDevices: 220 },
      { ...baseInput, contacts: 0, groupDevices: 5 },
      { ...baseInput, socketSlopeMb: 5, contacts: 1000, groupDevices: 800 },
      // Boundary/adversarial fixtures: zero and 2000-cap tracked devices,
      // and a negative groupDevices input (never expected from a real
      // caller, but Math.max floors it to the minimum, never crashing or
      // collapsing to dmOnly).
      { ...baseInput, groupDevices: 2000 },
      { ...baseInput, groupDevices: -5 },
      { ...baseInput, contacts: 0, socketSlopeMb: 0, groupDevices: 0 },
    ];

    for (const fixture of fixtures) {
      const { dmOnly, groupEnabled } = composeSessionMb(fixture);
      expect(groupEnabled).toBeGreaterThan(dmOnly);
    }
  });

  it('dm_only_ignores_group_devices_and_group_enabled_adds_group_state', () => {
    const result = composeSessionMb({ ...baseInput, groupDevices: 220 });
    const expectedDmOnly =
      baseInput.socketSlopeMb + baseInput.signalMbPerContact * baseInput.contacts;
    expect(result.dmOnly).toBeCloseTo(expectedDmOnly, 6);

    const expectedGroupState = groupStateMb({
      trackedDevices: Math.max(220, 1),
      recordKb: baseInput.recordKb,
    });
    expect(result.groupEnabled).toBeCloseTo(expectedDmOnly + expectedGroupState, 6);
  });
});

describe('exceedsRedesignThreshold', () => {
  it('blended_at_or_above_sixty_mb_flags_the_redesign_fork', () => {
    const below = exceedsRedesignThreshold(59.9);
    expect(below.exceeds).toBe(false);
    expect(below.reason).toMatch(/60/);

    const atThreshold = exceedsRedesignThreshold(60.0);
    expect(atThreshold.exceeds).toBe(true);
    expect(atThreshold.reason).toMatch(/60/);

    const above = exceedsRedesignThreshold(75);
    expect(above.exceeds).toBe(true);
  });

  it('boundary_values_around_sixty_including_float_arithmetic_that_lands_on_sixty', () => {
    expect(exceedsRedesignThreshold(59.999).exceeds).toBe(false);
    expect(exceedsRedesignThreshold(60.001).exceeds).toBe(true);
    // 0.1 * 600 in IEEE 754 double math does not land on exactly 60 - pin
    // whatever the actual float value is, and assert the verdict is still
    // consistent with a direct >= 60 check (never silently inverted).
    const floatSixty = 0.1 * 600;
    const result = exceedsRedesignThreshold(floatSixty);
    expect(result.exceeds).toBe(floatSixty >= 60);
  });
});
