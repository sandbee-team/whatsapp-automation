import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from './banned-claims.js';
import { SAFE_MODE_DISCLAIMER } from './disclosures.js';
import { PACING_COPY } from './pacing-copy.js';

/**
 * pacing-copy.test.ts (P13a Unit U1, step 1) - copy-purity proof for the
 * warm-up/pacing notification strings, mirroring
 * `tests/copy/onboarding-copy.test.ts`'s own shape (banned-claims scan,
 * disclaimer co-presence, byte-identical drift guard).
 */

/** English + Hinglish banned claims, normalized the same way check-copy.ts does. */
function containsBannedClaim(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return BANNED_CLAIMS.find((claim) => normalized.includes(claim.toLowerCase()));
}

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

describe('PACING_COPY', () => {
  it('pacing_copy_contains_no_banned_claims_and_carries_the_disclaimer', () => {
    const allStrings = collectStrings(PACING_COPY);
    expect(allStrings.length).toBeGreaterThan(0);

    // (a) no banned claim (en + Hinglish), case-insensitively, anywhere.
    for (const value of allStrings) {
      const hit = containsBannedClaim(value);
      expect(hit, `banned claim "${String(hit)}" found in: "${value}"`).toBeUndefined();
    }

    // (b) the copy module's disclaimer constant is byte-identical to the
    // canonical SAFE_MODE_DISCLAIMER - drift guard (the onboarding.ts idiom).
    expect(PACING_COPY.safeModeDisclaimer).toBe(SAFE_MODE_DISCLAIMER);
    expect(allStrings).toContain(SAFE_MODE_DISCLAIMER);

    // (c) every named string is present and non-empty.
    expect(PACING_COPY.warmupInProgress.trim().length).toBeGreaterThan(0);
    expect(PACING_COPY.warmupFrozenWatch.trim().length).toBeGreaterThan(0);
    expect(PACING_COPY.warmupAdvanced.trim().length).toBeGreaterThan(0);
    expect(PACING_COPY.warmupRolledBack.trim().length).toBeGreaterThan(0);

    // (d) never a guarantee/ban-avoidance promise beyond the shared banned
    // list - the rollback copy in particular must never promise anything
    // about bans/restrictions.
    expect(PACING_COPY.warmupRolledBack.toLowerCase()).not.toContain('guarantee');
  });

  it('pause_copy_has_no_banned_claims_and_carries_the_disclaimer', () => {
    const pauseStrings = [
      PACING_COPY.instancePausedRestriction,
      PACING_COPY.healthWatch,
      PACING_COPY.healthDegraded,
      PACING_COPY.healthCriticalPaused,
      PACING_COPY.resumeConfirm,
    ];

    for (const value of pauseStrings) {
      expect(value.trim().length).toBeGreaterThan(0);
      const hit = containsBannedClaim(value);
      expect(hit, `banned claim "${String(hit)}" found in: "${value}"`).toBeUndefined();
    }

    // Every new string co-locates the disclaimer somewhere in this same
    // module's source bytes (check-copy.ts's own clause (b) - proved at the
    // file level via the byte-identical drift guard above, so this only
    // needs to confirm the new strings themselves are present in PACING_COPY).
    const allStrings = collectStrings(PACING_COPY);
    expect(allStrings).toEqual(expect.arrayContaining(pauseStrings));

    // NEVER a timer/retry-window/recovery/immunity promise (design canon,
    // step 10's own explicit ban list for resumeConfirm - the shared
    // BANNED_CLAIMS scan above already covers the exact banned phrase for
    // an immunity-to-restriction claim).
    const resumeLower = PACING_COPY.resumeConfirm.toLowerCase();
    expect(resumeLower).not.toMatch(/retry in \d+/);
    expect(resumeLower).not.toContain('24h');
    expect(resumeLower).not.toContain('24 hours');
    expect(resumeLower).not.toContain('guarantee');

    // instance_paused_restriction/health_critical_paused never promise
    // anything about the restriction itself resolving or being appealed.
    expect(PACING_COPY.instancePausedRestriction.toLowerCase()).not.toContain('guarantee');
    expect(PACING_COPY.healthCriticalPaused.toLowerCase()).not.toContain('guarantee');
  });
});
