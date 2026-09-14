import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from '@wp/domain';
import { catalogues } from '@wp/i18n';

/**
 * Proves the `@wp/i18n` catalogues carry no banned claim (English or
 * Hinglish/Devanagari) - core invariant 6 (honest product, no
 * restriction-avoidance promises). Lives here (not in `@wp/domain` or
 * `@wp/i18n` themselves) because both those packages must stay dependency-
 * free of each other (design doc `@wp/i18n` section: "no React import...");
 * `scripts/` already imports `@wp/domain` (see check-copy.ts) and now also
 * `@wp/i18n`, so this is the one place both are legally importable together.
 */
describe('i18n catalogues carry no banned claim', () => {
  it('no_catalogue_string_contains_a_banned_claim', () => {
    const violations: { locale: string; key: string; claim: string }[] = [];

    for (const [locale, catalogue] of Object.entries(catalogues)) {
      for (const [key, value] of Object.entries(catalogue)) {
        const normalized = value.toLowerCase();
        for (const claim of BANNED_CLAIMS) {
          if (normalized.includes(claim.toLowerCase())) {
            violations.push({ locale, key, claim });
          }
        }
      }
    }

    expect(
      violations,
      violations.map((v) => `${v.locale}.${v.key} contains banned claim "${v.claim}"`).join('\n'),
    ).toEqual([]);
  });
});
