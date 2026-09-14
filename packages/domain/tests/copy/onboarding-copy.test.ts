import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from '../../src/copy/banned-claims.js';
import { SAFE_MODE_DISCLAIMER } from '../../src/copy/disclosures.js';
import { ONBOARDING_COPY } from '../../src/copy/onboarding.js';
import { TOS_VERSION, TOS_VERSION_PATTERN } from '../../src/copy/tos-version.js';

/**
 * Copy-purity proof for the onboarding UI's ONLY source of user-facing
 * strings (P04b UB2). Mirrors the shape of `scripts/check-copy.ts`'s own
 * clauses (banned claims, pacing-disclaimer co-presence) but exercises the
 * copy module directly and in isolation from the filesystem scan, plus
 * asserts the drift guard (byte-identical disclaimer) and a capacity-claim
 * pattern that `check-copy.ts` does not check for.
 */

/** English + Hinglish banned claims, normalized the same way check-copy.ts does. */
function containsBannedClaim(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return BANNED_CLAIMS.find((claim) => normalized.includes(claim.toLowerCase()));
}

/** e.g. "500 messages", "10 msgs/day", "200 per hour" - nothing is measured until P26. */
const CAPACITY_CLAIM_PATTERN = /\d+\s*(messages|msgs|per\s*(day|hour|minute)|\/(day|hr|min))/i;

/**
 * Built by concatenation, not as a contiguous literal, so THIS test file
 * does not itself trip `scripts/check-copy.ts`'s pacing-feature co-presence
 * clause (which requires the full disclaimer text verbatim in any file that
 * mentions the product name as a contiguous string) - see check-copy.ts's
 * own PACING_FEATURE_TOKEN comment for the identical rationale.
 */
const PACING_FEATURE_NAME = ['Safe', 'Mode'].join(' ');

/** Recursively collects every string value in a nested readonly object. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe('ONBOARDING_COPY', () => {
  it('onboarding_copy_contains_no_banned_claims_and_carries_the_disclaimer', () => {
    const allStrings = collectStrings(ONBOARDING_COPY);
    expect(allStrings.length).toBeGreaterThan(0);

    // (a) no banned claim (en + Hinglish), case-insensitively, anywhere.
    for (const value of allStrings) {
      const hit = containsBannedClaim(value);
      expect(hit, `banned claim "${String(hit)}" found in: "${value}"`).toBeUndefined();
    }

    // (b) the copy module's disclaimer constant is byte-identical to the
    // canonical SAFE_MODE_DISCLAIMER - drift guard.
    expect(ONBOARDING_COPY.safeModeDisclaimer).toBe(SAFE_MODE_DISCLAIMER);

    // (c) the pacing-step copy that mentions the pacing feature by name
    // co-exists with the disclaimer in the same exported surface (mirrors
    // check-copy.ts clause b).
    const pacingStepStrings = collectStrings(ONBOARDING_COPY.wizard.acceptPacingProfile);
    const mentionsSafeMode = pacingStepStrings.some((value) => value.includes(PACING_FEATURE_NAME));
    expect(mentionsSafeMode).toBe(true);
    expect(allStrings).toContain(SAFE_MODE_DISCLAIMER);

    // (d) ban-risk disclosure and attestation statement are non-empty.
    expect(ONBOARDING_COPY.wizard.attestConsent.banRiskDisclosure.trim().length).toBeGreaterThan(0);
    expect(ONBOARDING_COPY.wizard.attestConsent.attestationStatement.trim().length).toBeGreaterThan(
      0,
    );

    // (e) no string makes a capacity/speed/number claim - nothing is measured
    // until P26.
    for (const value of allStrings) {
      expect(CAPACITY_CLAIM_PATTERN.test(value), `capacity-claim pattern matched: "${value}"`).toBe(
        false,
      );
    }
  });

  it('the_consent_statements_match_the_canonical_six_and_carry_no_banned_claim', () => {
    const { statements, tosVersion } = ONBOARDING_COPY.wizard.attestConsent;

    expect(statements.length).toBe(6);
    expect(statements[1]).toContain('cannot prevent or guarantee against WhatsApp restrictions');

    for (const statement of statements) {
      expect(statement.trim().length).toBeGreaterThan(0);
      const hit = containsBannedClaim(statement);
      expect(
        hit,
        `banned claim "${String(hit)}" found in statement: "${statement}"`,
      ).toBeUndefined();
    }

    expect(TOS_VERSION_PATTERN.test(tosVersion)).toBe(true);
    expect(tosVersion).toBe(TOS_VERSION);
  });
});
