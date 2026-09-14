import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS, BROADCAST_DISCLOSURE } from '@wp/domain';
import { scanCopy, runCheckCopy } from '../check-copy.js';
import { REPO_ROOT } from './registry.js';

/**
 * check-copy-broadcast.test.ts (P23a Unit U5) - sibling of `check-copy.test.ts`
 * (that file sits at the `max-lines: 300` cap - core-invariants.md's
 * mandatory split idiom, sibling module rather than trimming that file's
 * contract/behaviour comments). Proves the broadcast panel's i18n catalogues
 * carry the required disclosure and ship zero banned claims, over the REAL
 * files on disk.
 *
 * NB: this file is itself scanned by `runCheckCopy()`'s real-tree pass (it
 * lives under `scripts/**`), so - same discipline as `check-copy.test.ts`'s
 * own header note - it never spells a banned phrase or the capitalized
 * product-name token as a literal; both are built by concatenation so this
 * file's own source text never contains them.
 */

const FAN_OUT_FEATURE_TOKEN = ['Broad', 'cast'].join('');
const DISALLOWED_MARKETING_PHRASES = [['ban', 'proof'].join('-'), ['instant', 'bulk'].join(' ')];

const EN_PATH = 'packages/i18n/src/catalogues/en-broadcasts.ts';
const HI_PATH = 'packages/i18n/src/catalogues/hi-broadcasts.ts';

function readCatalogue(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('broadcast panel copy (P23a Unit U5)', () => {
  it('broadcast_panel_copy_requires_the_disclosure_and_contains_no_banned_claims', () => {
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
    // (c) fires: a file naming the product without shipping the disclosure
    // text is flagged.
    const strippedEnContent = enContent.split(BROADCAST_DISCLOSURE).join('');
    const strippedViolations = scanCopy(
      [{ path: EN_PATH, content: strippedEnContent }],
      BANNED_CLAIMS,
    );
    expect(strippedViolations.length).toBeGreaterThan(0);
    expect(
      strippedViolations.some((violation) => violation.message.includes(FAN_OUT_FEATURE_TOKEN)),
    ).toBe(true);

    const lowerEn = enContent.toLowerCase();
    const lowerHi = hiContent.toLowerCase();
    for (const phrase of DISALLOWED_MARKETING_PHRASES) {
      expect(lowerEn).not.toContain(phrase);
      expect(lowerHi).not.toContain(phrase);
    }

    const result = runCheckCopy();
    expect(result.violations).toEqual([]);
  });
});
