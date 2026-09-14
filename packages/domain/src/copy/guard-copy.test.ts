import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from './banned-claims.js';
import { GUARD_COPY } from './guard-copy.js';
import { DENY_REASONS } from '../pacing/deny-reasons.js';

/**
 * guard-copy.test.ts (P14 Unit U7, step 9) - the two named tests the phase
 * file specifies: exhaustiveness over every `DenyReason` (a new member with
 * no copy entry fails this test) and a banned-claims scan over every en/hi
 * string (mirrors `check-copy.ts`'s own scan, run here directly against the
 * object rather than through the file-scanning guard).
 */

describe('guard-copy', () => {
  it('every_deny_reason_has_an_en_and_hi_string', () => {
    const keys = Object.keys(GUARD_COPY);
    expect(keys.sort()).toEqual([...DENY_REASONS].sort());
    expect(keys.length).toBe(DENY_REASONS.length);

    for (const reason of DENY_REASONS) {
      const entry = GUARD_COPY[reason];
      expect(entry.en.length).toBeGreaterThan(0);
      expect(entry.hi.length).toBeGreaterThan(0);
    }
  });

  it('guard_copy_contains_no_banned_claims', () => {
    for (const reason of DENY_REASONS) {
      const entry = GUARD_COPY[reason];
      for (const claim of BANNED_CLAIMS) {
        expect(entry.en.toLowerCase()).not.toContain(claim.toLowerCase());
        expect(entry.hi.toLowerCase()).not.toContain(claim.toLowerCase());
      }
    }
  });

  it('blocked_word_copy_never_contains_a_matched_word_only_a_category_placeholder', () => {
    expect(GUARD_COPY.BLOCKED_WORD.en).toContain('{category}');
    expect(GUARD_COPY.BLOCKED_WORD.hi).toContain('{category}');
  });

  it('opt_out_copy_says_cancelled_not_failed', () => {
    expect(GUARD_COPY.OPT_OUT.en.toLowerCase()).not.toContain('failed');
    expect(GUARD_COPY.OPT_OUT.hi).not.toContain('विफल');
  });
});
