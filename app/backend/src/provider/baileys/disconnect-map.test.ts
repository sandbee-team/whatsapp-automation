import { describe, expect, it } from 'vitest';
import { DisconnectReason } from 'baileys';
import { DISCONNECT_MAP, UNKNOWN_CODE_POLICY, resolveDisconnect } from './disconnect-map.js';

/**
 * disconnect-map.test.ts (P08 U1 step 3, written FIRST) - the normative
 * disconnect table. `disconnect_map_covers_every_enum_member` is mandatory
 * suite test 10 (ADR 0013's P08 implementation note references it by name):
 * it iterates every numeric member of the LIVE `DisconnectReason` enum, so a
 * future Baileys upgrade that adds a member fails this test rather than
 * silently leaving it unmapped.
 */

function liveNumericMembers(): number[] {
  const raw = DisconnectReason as unknown as Record<string, number | string>;
  const numeric: number[] = [];
  for (const [key, value] of Object.entries(raw)) {
    // Numeric TS enums have reverse mappings (name -> number AND number ->
    // name); only take the name -> number direction, once per member.
    if (typeof value === 'number' && Number.isNaN(Number(key))) {
      numeric.push(value);
    }
  }
  return numeric;
}

describe('disconnect_map_covers_every_enum_member', () => {
  it('has a row for every live DisconnectReason numeric member', () => {
    const members = liveNumericMembers();
    expect(members.length).toBeGreaterThan(0);
    for (const code of members) {
      expect(DISCONNECT_MAP[code]).toBeDefined();
    }
  });
});

describe('never_auto_reconnect_codes_are_401_402_403_406_411_440_500', () => {
  const neverReconnect: ReadonlyArray<{
    code: number;
    healthState: string;
    action: string;
  }> = [
    { code: 401, healthState: 'logged_out', action: 'purge_relink' },
    { code: 402, healthState: 'paused', action: 'restriction_pause' },
    { code: 403, healthState: 'paused', action: 'restriction_pause' },
    { code: 406, healthState: 'paused', action: 'restriction_pause' },
    { code: 411, healthState: 'logged_out', action: 'purge_relink' },
    { code: 440, healthState: 'paused', action: 'session_replaced' },
    { code: 500, healthState: 'logged_out', action: 'purge_relink' },
  ];

  for (const expected of neverReconnect) {
    it(`code ${String(expected.code)} never auto-reconnects`, () => {
      const row = DISCONNECT_MAP[expected.code];
      expect(row).toBeDefined();
      expect(row?.autoReconnect).toBe(false);
      expect(row?.healthState).toBe(expected.healthState);
      expect(row?.action).toBe(expected.action);
    });
  }
});

describe('known transient codes reconnect with the documented budget', () => {
  it('515 restartRequired stays connected, is never surfaced as an error, uses its own budget, never degrades', () => {
    const row = DISCONNECT_MAP[515];
    expect(row).toBeDefined();
    expect(row?.healthState).toBe('connected');
    expect(row?.linkState).toBe('linked');
    expect(row?.autoReconnect).toBe(true);
    expect(row?.budget).toBe('restart515');
    expect(row?.surfaceAsError).toBe(false);
  });

  it('428 connectionClosed degrades and backs off', () => {
    const row = DISCONNECT_MAP[428];
    expect(row?.healthState).toBe('degraded');
    expect(row?.autoReconnect).toBe(true);
    expect(row?.budget).toBe('backoff');
  });

  it('408 connectionLost/timedOut (one shared code) degrades and backs off', () => {
    const row = DISCONNECT_MAP[408];
    expect(row?.healthState).toBe('degraded');
    expect(row?.autoReconnect).toBe(true);
    expect(row?.budget).toBe('backoff');
  });

  it('503 unavailableService degrades and backs off with a x5 base multiplier', () => {
    const row = DISCONNECT_MAP[503];
    expect(row?.healthState).toBe('degraded');
    expect(row?.autoReconnect).toBe(true);
    expect(row?.budget).toBe('backoff');
    expect(row?.baseMultiplier).toBe(5);
  });
});

describe('unknown_code_degrades_then_pauses_after_two_attempts', () => {
  it('UNKNOWN_CODE_POLICY has a shorter, limited(2) leash', () => {
    expect(UNKNOWN_CODE_POLICY.healthState).toBe('degraded');
    expect(UNKNOWN_CODE_POLICY.linkState).toBe('unchanged');
    expect(UNKNOWN_CODE_POLICY.budget).toBe('limited2');
    expect(UNKNOWN_CODE_POLICY.action).toBe('unmapped');
  });

  it('resolveDisconnect on an unmapped code reports mapped: false and returns the unknown policy', () => {
    const result = resolveDisconnect(999_999);
    expect(result.mapped).toBe(false);
    expect(result.row).toEqual(UNKNOWN_CODE_POLICY);
  });

  it('resolveDisconnect on a mapped code reports mapped: true with the real row', () => {
    const result = resolveDisconnect(401);
    expect(result.mapped).toBe(true);
    expect(result.row).toEqual(DISCONNECT_MAP[401]);
  });
});
