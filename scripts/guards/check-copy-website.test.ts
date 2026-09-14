import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS, SAFE_MODE_DISCLAIMER, BROADCAST_DISCLOSURE } from '@wp/domain';
import { scanCopy, runCheckCopy, COPY_GLOBS } from '../check-copy.js';
import { ARTIFACT_EXCLUSIONS, CONTENT_EXCLUSIONS, REPO_ROOT, resolveFiles } from './scan-config.js';
import { gateCSentence, readMeasuredN } from './copy-public-capacity-lib.js';

/**
 * check-copy-website.test.ts (P29 step 4, Unit U1) - proves the copy guard's
 * existing clauses already reach the marketing website (already in scope via
 * `SCAN_GLOBS`) and exercises the new clause (e): a derived capacity/cost
 * figure quoted on a public surface.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/copy';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-copy website public surface (P29 step 4)', () => {
  it('website_content_is_scanned_with_a_non_zero_matched_file_count', () => {
    const matchedFiles = resolveFiles(COPY_GLOBS);
    const websiteFiles = matchedFiles.filter((p) => p.startsWith('website/'));

    expect(websiteFiles.length).toBeGreaterThan(0);
    expect(matchedFiles).toContain('website/package.json');
    expect(COPY_GLOBS.some((g) => g.includes('mdx'))).toBe(true);
    expect(ARTIFACT_EXCLUSIONS).toContain('website/out/**');
    expect(ARTIFACT_EXCLUSIONS).toContain('**/.next/**');
    expect(CONTENT_EXCLUSIONS).toEqual(['demo/**', '.memory/**', 'scripts/guards/__fixtures__/**']);
  });

  it('a_banned_claim_in_hindi_marketing_copy_is_rejected', () => {
    const filePath = `${FIXTURES_DIR}/hindi-marketing-banned.mdx`;
    const content = readFixture('hindi-marketing-banned.mdx');
    const violations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);

    const expectedClaims = BANNED_CLAIMS.filter((claim) =>
      content.toLowerCase().includes(claim.toLowerCase()),
    );
    expect(expectedClaims.length).toBe(3);
    for (const claim of expectedClaims) {
      expect(violations.some((violation) => violation.message.includes(claim))).toBe(true);
    }
  });

  it('a_broadcast_page_without_the_broadcast_disclosure_is_rejected', () => {
    const filePath = 'website/content/docs/what-broadcast-means.mdx';
    const content = readFixture('website-broadcast-no-disclosure.mdx');

    const badViolations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);
    expect(badViolations.some((v) => v.message.includes('disclosure'))).toBe(true);

    const goodContent = `${content}\n\n${BROADCAST_DISCLOSURE}`;
    const goodViolations = scanCopy([{ path: filePath, content: goodContent }], BANNED_CLAIMS);
    expect(goodViolations).toEqual([]);
  });

  it('a_safe_mode_page_without_the_disclaimer_is_rejected', () => {
    const filePath = 'website/content/docs/what-safe-mode-means.mdx';
    const content = readFixture('website-safe-mode-no-disclaimer.mdx');

    const badViolations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);
    expect(badViolations.some((v) => v.message.includes('disclaimer'))).toBe(true);

    const goodContent = `${content}\n\n${SAFE_MODE_DISCLAIMER}`;
    const goodViolations = scanCopy([{ path: filePath, content: goodContent }], BANNED_CLAIMS);
    expect(goodViolations).toEqual([]);
  });

  it('a_derived_capacity_or_cost_number_on_a_public_page_is_rejected', () => {
    const filePath = 'website/src/content/copy/capacity.ts';
    const offendingLines = [
      'handles 10,000 concurrent sessions',
      '$0.28/number per month',
      '18 MB per session',
      '2,000 sessions today',
      '2000 concurrent numbers',
      '600 sends/day',
      'p99 under 25 ms',
    ];

    for (const line of offendingLines) {
      const violations = scanCopy([{ path: filePath, content: line }], BANNED_CLAIMS, {
        measuredN: '1,000',
      });
      expect(
        violations.some((v) => v.message.includes('Gate C')),
        `expected a Gate C violation for line "${line}"`,
      ).toBe(true);
    }

    const permittedLine = gateCSentence('1,000');
    const permittedViolations = scanCopy(
      [{ path: filePath, content: permittedLine }],
      BANNED_CLAIMS,
      {
        measuredN: '1,000',
      },
    );
    expect(permittedViolations).toEqual([]);

    const staleNLine = gateCSentence('5,000');
    const staleNViolations = scanCopy([{ path: filePath, content: staleNLine }], BANNED_CLAIMS, {
      measuredN: '1,000',
    });
    expect(staleNViolations.some((v) => v.message.includes('Gate C'))).toBe(true);

    const noMeasuredNViolations = scanCopy(
      [{ path: filePath, content: gateCSentence('1,000') }],
      BANNED_CLAIMS,
    );
    expect(noMeasuredNViolations.some((v) => v.message.includes('Gate C'))).toBe(true);

    const nonPublicViolations = scanCopy(
      [{ path: 'docs/capacity/notes.md', content: 'handles 10,000 concurrent sessions' }],
      [],
    );
    expect(nonPublicViolations).toEqual([]);

    const fleetCapacityDocText = readFileSync(
      path.join(REPO_ROOT, 'docs/capacity/fleet-capacity.md'),
      'utf8',
    );
    const measuredN = readMeasuredN(fleetCapacityDocText);
    expect(measuredN).toMatch(/^\d[\d,]*$/);
  });

  it('the_real_website_tree_has_zero_public_capacity_violations', () => {
    const result = runCheckCopy();
    expect(result.violations.filter((v) => v.file.startsWith('website/'))).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});
