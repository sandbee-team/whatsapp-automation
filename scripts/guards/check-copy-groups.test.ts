import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from '@wp/domain';
import { scanCopy, runCheckCopy } from '../check-copy.js';
import { REPO_ROOT } from './registry.js';

/**
 * check-copy-groups.test.ts (P24 groups-messaging Unit U2) - sibling of
 * `check-copy-broadcast.test.ts` (that file already proves the broadcast
 * clause; this one proves clause (d), the group risk disclosure). Proves the
 * groups panel's i18n catalogues carry the required disclosure and ship zero
 * banned claims, over the REAL files on disk.
 *
 * NB: this file is itself scanned by `runCheckCopy()`'s real-tree pass (it
 * lives under `scripts/**`), so - same discipline as
 * `check-copy-broadcast.test.ts`'s own header note - it never spells a
 * banned phrase or the capitalized product-name token as a literal, and it
 * never places the group feature token contiguous with the disclosure text;
 * both are built by concatenation/import so this file's own source text
 * never trips its own clause under test.
 */

const GROUP_FEATURE_TOKEN = ['Gro', 'up'].join('');

const EN_PATH = 'packages/i18n/src/catalogues/en-groups.ts';
const HI_PATH = 'packages/i18n/src/catalogues/hi-groups.ts';

function readCatalogue(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('groups panel copy (P24 groups-messaging Unit U2)', () => {
  it('groups_panel_copy_requires_the_disclosure_and_contains_no_banned_claims', () => {
    const enContent = readCatalogue(EN_PATH);
    const hiContent = readCatalogue(HI_PATH);

    const liveViolations = scanCopy(
      [
        { path: EN_PATH, content: enContent },
        { path: HI_PATH, content: hiContent },
      ],
      BANNED_CLAIMS,
    );
    expect(liveViolations).toEqual([]);

    // Strip the disclosure literal from the EN catalogue and prove clause
    // (d) fires: a file naming the group feature without shipping the
    // disclosure text is flagged.
    const groupRiskDisclosure = enContent
      .split('const GROUP_RISK_DISCLOSURE_LITERAL = `')[1]
      ?.split('`;')[0];
    expect(typeof groupRiskDisclosure).toBe('string');
    const strippedEnContent = groupRiskDisclosure
      ? enContent.split(groupRiskDisclosure).join('')
      : enContent;
    const strippedViolations = scanCopy(
      [{ path: EN_PATH, content: strippedEnContent }],
      BANNED_CLAIMS,
    );
    expect(strippedViolations.length).toBeGreaterThan(0);
    expect(
      strippedViolations.some((violation) => violation.message.includes(GROUP_FEATURE_TOKEN)),
    ).toBe(true);

    const result = runCheckCopy();
    expect(result.violations).toEqual([]);
  });

  it('a_capitalized_group_mention_under_app_frontend_src_without_the_disclosure_is_flagged', () => {
    // P24 C1 fix round, Finding 6: clause (d) must also guard the panel
    // itself (`app/frontend/src/`), not just the i18n catalogues - a
    // synthetic, purely in-memory fixture (never written to disk) proves
    // the scoped prefix now catches a real component surface.
    const fixturePath = 'app/frontend/src/features/x.tsx';
    const fixtureContent = `export function X() { return <span>${GROUP_FEATURE_TOKEN}s are risky</span>; }`;

    const violations = scanCopy([{ path: fixturePath, content: fixtureContent }], BANNED_CLAIMS);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(fixturePath);
    expect(violations[0]?.message).toContain(GROUP_FEATURE_TOKEN);
  });

  it('group_copy_never_claims_group_sending_is_safe', () => {
    const enContent = readCatalogue(EN_PATH);
    const hiContent = readCatalogue(HI_PATH);

    const bannedShapeWords = [['safe'].join(''), ['protected'].join(''), 'guaranteed'];
    const banProofPhrase = ['ban', 'proof'].join('-');
    const hindiSafe = 'सुरक्षित';
    const hindiGuarantee = 'गारंटी';

    const lowerEn = enContent.toLowerCase();
    const lowerHi = hiContent.toLowerCase();

    for (const word of bannedShapeWords) {
      const re = new RegExp(`\\b${word}\\b`, 'i');
      expect(re.test(enContent)).toBe(false);
      expect(re.test(hiContent)).toBe(false);
    }
    expect(lowerEn.includes(banProofPhrase)).toBe(false);
    expect(lowerHi.includes(banProofPhrase)).toBe(false);
    expect(hiContent.includes(hindiSafe)).toBe(false);
    expect(hiContent.includes(hindiGuarantee)).toBe(false);
  });
});
