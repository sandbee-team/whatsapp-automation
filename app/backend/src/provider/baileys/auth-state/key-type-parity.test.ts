import type { SignalDataTypeMap } from 'baileys';
import { describe, expect, it } from 'vitest';
import { classifyAuthKeyType, type AuthKeyType } from '@wp/domain';

/**
 * Compile-time parity proof between the pinned `baileys@7.0.0-rc14`'s
 * `SignalDataTypeMap` and `@wp/domain`'s `AuthKeyType` (P07 Unit U1). Both
 * `Exclude<...>` types must be exactly `never` in BOTH directions - if
 * baileys ever adds/removes/renames a key type, one of the two type-only
 * assignments below stops compiling (`never` is the only type assignable to
 * itself here), forcing the tier tables in `auth-key-types.ts` to be updated
 * deliberately rather than silently drifting out of sync.
 */
type MissingFromDomain = Exclude<keyof SignalDataTypeMap, AuthKeyType>;
type MissingFromBaileys = Exclude<AuthKeyType, keyof SignalDataTypeMap>;

// Type-only proofs - never constructed or executed, only type-checked.
type ProofNoMissingFromDomain = MissingFromDomain extends never ? true : never;
type ProofNoMissingFromBaileys = MissingFromBaileys extends never ? true : never;
const proofNoMissingFromDomain: ProofNoMissingFromDomain = true;
const proofNoMissingFromBaileys: ProofNoMissingFromBaileys = true;
void proofNoMissingFromDomain;
void proofNoMissingFromBaileys;

describe('baileys SignalDataTypeMap <-> @wp/domain AuthKeyType parity', () => {
  it('all_ten_pinned_baileys_key_types_classify_to_the_decided_tier', () => {
    expect(classifyAuthKeyType('pre-key' satisfies keyof SignalDataTypeMap)).toBe('durable');
    expect(classifyAuthKeyType('app-state-sync-key' satisfies keyof SignalDataTypeMap)).toBe(
      'durable',
    );
    expect(classifyAuthKeyType('app-state-sync-version' satisfies keyof SignalDataTypeMap)).toBe(
      'durable',
    );

    expect(classifyAuthKeyType('session' satisfies keyof SignalDataTypeMap)).toBe('signal');
    expect(classifyAuthKeyType('sender-key' satisfies keyof SignalDataTypeMap)).toBe('signal');
    expect(classifyAuthKeyType('identity-key' satisfies keyof SignalDataTypeMap)).toBe('signal');

    expect(classifyAuthKeyType('sender-key-memory' satisfies keyof SignalDataTypeMap)).toBe(
      'rebuildable',
    );
    expect(classifyAuthKeyType('lid-mapping' satisfies keyof SignalDataTypeMap)).toBe(
      'rebuildable',
    );
    expect(classifyAuthKeyType('device-list' satisfies keyof SignalDataTypeMap)).toBe(
      'rebuildable',
    );
    expect(classifyAuthKeyType('tctoken' satisfies keyof SignalDataTypeMap)).toBe('rebuildable');
  });

  it('exactly_ten_key_types_are_covered', () => {
    const allTen: Array<keyof SignalDataTypeMap> = [
      'pre-key',
      'app-state-sync-key',
      'app-state-sync-version',
      'session',
      'sender-key',
      'identity-key',
      'sender-key-memory',
      'lid-mapping',
      'device-list',
      'tctoken',
    ];
    expect(allTen.length).toBe(10);
    for (const type of allTen) {
      expect(() => classifyAuthKeyType(type)).not.toThrow();
    }
  });
});
