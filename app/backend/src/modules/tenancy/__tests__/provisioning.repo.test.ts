import { describe, expect, it } from 'vitest';
import { ALLOWED_AUDIT_METADATA_KEYS, filterAuditMetadata } from '../provisioning.repo.js';

/**
 * provisioning.repo.test.ts (P04a FIXA C1 review, FIX 8) - unit-only, no DB.
 * `insertAuditLog` itself is proven end to end by signup.integration.test.ts
 * (which always passes `metadata: null`); this is the one place the
 * allow-list filter's actual drop/keep behavior is exercised.
 */
describe('filterAuditMetadata (P04a FIXA FIX 8, audit metadata allow-list)', () => {
  it('drops_keys_not_on_the_allow_list_and_keeps_allowed_ones', () => {
    expect(ALLOWED_AUDIT_METADATA_KEYS.has('reason')).toBe(true);
    expect(ALLOWED_AUDIT_METADATA_KEYS.has('password')).toBe(false);

    const result = filterAuditMetadata({
      reason: 'manual override',
      password: 'should-never-survive',
      internal_debug_dump: { anything: 'here' },
    });

    expect(result).toEqual({ reason: 'manual override' });
  });

  it('never_throws_on_an_unknown_key_only_object', () => {
    expect(() => filterAuditMetadata({ totally_unknown: 'value' })).not.toThrow();
    expect(filterAuditMetadata({ totally_unknown: 'value' })).toBeNull();
  });

  it('returns_null_for_null_and_undefined_input', () => {
    expect(filterAuditMetadata(null)).toBeNull();
    expect(filterAuditMetadata(undefined)).toBeNull();
  });
});
