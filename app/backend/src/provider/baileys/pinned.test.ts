import { describe, expect, it } from 'vitest';
import { DisconnectReason } from 'baileys';
import { BAILEYS_PINNED_VERSION, DISCONNECT_REASON_SNAPSHOT, ENUM_REDERIVED_ON } from './pinned.js';

/**
 * pinned.test.ts (P08 U1 step 1) - the pinned Baileys version constant and a
 * re-derived, member-for-member snapshot of the live `DisconnectReason` enum.
 * The snapshot exists so `disconnect-map.ts` can key off plain numbers
 * without importing `baileys` at the data-table module itself, and so a
 * future Baileys upgrade that adds/removes/renumbers a member fails THIS
 * test rather than silently drifting.
 */
describe('pinned baileys version + DisconnectReason snapshot', () => {
  it('exports the pinned version as the exact string used by P07', () => {
    expect(BAILEYS_PINNED_VERSION).toBe('7.0.0-rc14');
  });

  it('records the date the enum snapshot was re-derived', () => {
    expect(ENUM_REDERIVED_ON).toBe('2026-08-31');
  });

  it('snapshot equals the live DisconnectReason enum member-for-member', () => {
    const liveEntries = Object.entries(DisconnectReason as unknown as Record<string, unknown>);
    const snapshotEntries = Object.entries(DISCONNECT_REASON_SNAPSHOT);

    expect(snapshotEntries.length).toBe(liveEntries.length);

    for (const [key, value] of liveEntries) {
      expect(DISCONNECT_REASON_SNAPSHOT).toHaveProperty(key, value);
    }
    for (const [key, value] of snapshotEntries) {
      expect((DisconnectReason as unknown as Record<string, unknown>)[key]).toBe(value);
    }
  });

  it('snapshot is a plain object, not the live enum reference', () => {
    expect(DISCONNECT_REASON_SNAPSHOT).not.toBe(DisconnectReason);
  });
});
