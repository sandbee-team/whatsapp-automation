import { describe, expect, it } from 'vitest';
import {
  classifyAuthKeyType,
  DURABLE_KEY_TYPES,
  MAX_TRACKED_GROUP_PARTICIPANT_DEVICES,
  REBUILDABLE_KEY_TYPES,
  SIGNAL_KEY_TTL_MS,
  SIGNAL_KEY_TYPES,
  UnknownAuthKeyTypeError,
} from './auth-key-types.js';

describe('auth key type classification', () => {
  it('unknown_auth_key_type_throws', () => {
    expect(() => classifyAuthKeyType('not-a-real-type')).toThrow(UnknownAuthKeyTypeError);
    expect(() => classifyAuthKeyType('')).toThrow(UnknownAuthKeyTypeError);
  });

  it('durable_key_types_classify_as_durable', () => {
    for (const type of DURABLE_KEY_TYPES) {
      expect(classifyAuthKeyType(type)).toBe('durable');
    }
  });

  it('signal_key_types_classify_as_signal', () => {
    for (const type of SIGNAL_KEY_TYPES) {
      expect(classifyAuthKeyType(type)).toBe('signal');
    }
  });

  it('rebuildable_key_types_classify_as_rebuildable', () => {
    for (const type of REBUILDABLE_KEY_TYPES) {
      expect(classifyAuthKeyType(type)).toBe('rebuildable');
    }
  });

  it('the_ten_types_are_partitioned_with_no_overlap_and_no_gap', () => {
    const all = [...DURABLE_KEY_TYPES, ...SIGNAL_KEY_TYPES, ...REBUILDABLE_KEY_TYPES];
    expect(all.length).toBe(10);
    expect(new Set(all).size).toBe(10);
  });

  it('constants_match_decided_values', () => {
    expect(SIGNAL_KEY_TTL_MS).toBe(2_592_000_000);
    expect(MAX_TRACKED_GROUP_PARTICIPANT_DEVICES).toBe(2000);
  });
});
