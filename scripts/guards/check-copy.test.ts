import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANNED_CLAIMS } from '@wp/domain';
import { scanCopy, runCheckCopy, COPY_GLOBS, BANNED_CLAIMS_EXEMPT_FILES } from '../check-copy.js';
import { resolveFiles } from './scan-config.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-copy.ts (P00 step 9, core invariant 6: honest
 * product, no restriction-avoidance promises). `scanCopy` is pure over
 * already-read source text - every case feeds it fixture content under a
 * synthetic path, never touching the real filesystem scan. `BANNED_CLAIMS`
 * is imported from `@wp/domain`, never hand-copied here.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/copy';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-copy (P00 step 9)', () => {
  // The cases below derive the *expected* claim set from `BANNED_CLAIMS`
  // itself rather than hand-typing a banned phrase into this test file (that
  // would itself trip this same guard's clause (a) on its own real-tree scan).

  it('banned_claim_in_english_is_rejected', () => {
    const filePath = `${FIXTURES_DIR}/banned-english.md`;
    const content = readFixture('banned-english.md');
    const violations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);

    const expectedClaims = BANNED_CLAIMS.filter((claim) =>
      content.toLowerCase().includes(claim.toLowerCase()),
    );
    // The fixture (see task spec) embeds 3 distinct banned phrases.
    expect(expectedClaims.length).toBe(3);
    for (const claim of expectedClaims) {
      expect(violations.some((violation) => violation.message.includes(claim))).toBe(true);
    }
  });

  it('banned_claim_in_hinglish_is_rejected', () => {
    const filePath = `${FIXTURES_DIR}/banned-hinglish.md`;
    const content = readFixture('banned-hinglish.md');
    const violations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);

    const expectedClaims = BANNED_CLAIMS.filter((claim) =>
      content.toLowerCase().includes(claim.toLowerCase()),
    );
    // The fixture (see task spec) embeds 3 distinct banned phrases.
    expect(expectedClaims.length).toBe(3);
    for (const claim of expectedClaims) {
      expect(violations.some((violation) => violation.message.includes(claim))).toBe(true);
    }
  });

  it('safe_mode_string_without_the_disclaimer_is_rejected', () => {
    const badPath = `${FIXTURES_DIR}/safe-mode-no-disclaimer.ts`;
    const goodPath = `${FIXTURES_DIR}/safe-mode-with-disclaimer.ts`;

    const violations = scanCopy(
      [
        { path: badPath, content: readFixture('safe-mode-no-disclaimer.ts') },
        { path: goodPath, content: readFixture('safe-mode-with-disclaimer.ts') },
      ],
      BANNED_CLAIMS,
    );

    // Bad: mentions the pacing feature but never ships the disclaimer text -
    // flagged.
    expect(violations.some((violation) => violation.file === badPath)).toBe(true);

    // Good: mentions the pacing feature AND ships the disclaimer text
    // verbatim in the same file - never flagged.
    expect(violations.some((violation) => violation.file === goodPath)).toBe(false);
  });

  it('broadcast_string_without_the_disclosure_is_rejected', () => {
    const badPath = `${FIXTURES_DIR}/broadcast-no-disclosure.ts`;
    const goodPath = `${FIXTURES_DIR}/broadcast-with-disclosure.ts`;
    const lowercasePath = `${FIXTURES_DIR}/lowercase-broadcast-ok.ts`;

    const violations = scanCopy(
      [
        { path: badPath, content: readFixture('broadcast-no-disclosure.ts') },
        { path: goodPath, content: readFixture('broadcast-with-disclosure.ts') },
        { path: lowercasePath, content: readFixture('lowercase-broadcast-ok.ts') },
      ],
      BANNED_CLAIMS,
    );

    // Bad: mentions the feature but never ships the disclosure text - flagged.
    expect(violations.some((violation) => violation.file === badPath)).toBe(true);

    // Good: mentions the feature AND ships the disclosure text - never flagged.
    expect(violations.some((violation) => violation.file === goodPath)).toBe(false);

    // Good: a generic lowercase word use (not the capitalized product name)
    // never triggers the case-sensitive, word-boundary match.
    expect(violations.some((violation) => violation.file === lowercasePath)).toBe(false);
  });

  it('banned_claim_with_smart_quotes_is_rejected', () => {
    // A curly/smart apostrophe (U+2019) variant of a banned phrase must
    // still be caught - clause (a) normalizes haystack and needles first.
    const filePath = `${FIXTURES_DIR}/banned-curly.md`;
    const content = readFixture('banned-curly.md');
    const violations = scanCopy([{ path: filePath, content }], BANNED_CLAIMS);

    const apostropheClaim = BANNED_CLAIMS.find((claim) => claim.includes("'"));
    expect(apostropheClaim).toBeDefined();
    expect(
      violations.some((violation) => violation.message.includes(apostropheClaim as string)),
    ).toBe(true);
  });

  it('copy_exemptions_are_exactly_the_banned_claims_source', () => {
    expect(BANNED_CLAIMS_EXEMPT_FILES).toEqual(['packages/domain/src/copy/banned-claims.ts']);
  });

  it('the_banned_claims_source_file_is_exempt_only_from_the_banned_claims_clause', () => {
    const exemptPath = BANNED_CLAIMS_EXEMPT_FILES[0] as string;
    const content = readFileSync(path.join(REPO_ROOT, exemptPath), 'utf8');

    // Clause (a) does not fire on its own source list, even though the
    // content is, by definition, entirely banned phrases.
    const violations = scanCopy([{ path: exemptPath, content }], BANNED_CLAIMS);
    expect(violations).toEqual([]);
  });

  // --- Edge-case / adversarial pass (session C2) -------------------------

  it('an_empty_file_list_produces_no_violations', () => {
    expect(scanCopy([], BANNED_CLAIMS)).toEqual([]);
  });

  it('an_empty_claims_list_flags_nothing_even_on_dirty_content', () => {
    const content = readFixture('banned-english.md');
    expect(scanCopy([{ path: 'x.md', content }], [])).toEqual([]);
  });

  it('a_claim_at_the_last_line_with_no_trailing_newline_is_still_reported_at_the_right_line', () => {
    // Built dynamically from BANNED_CLAIMS itself (never hand-typed here -
    // see the file header note): two clean lines, then the claim on line 3,
    // with no trailing "\n" after it.
    const claim = BANNED_CLAIMS[0] as string;
    const content = `Line one is clean.\nLine two is clean too.\nWe are ${claim} for everyone`;

    const violations = scanCopy([{ path: 'no-trailing-newline.md', content }], BANNED_CLAIMS);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });

  it('crlf_line_endings_still_report_the_correct_line_number', () => {
    // Windows repo: take the already-approved LF fixture and convert it to
    // CRLF in memory (no new dirty fixture file needed) - the guard's line
    // counter must not be thrown off by the trailing "\r" on each line.
    const lfContent = readFixture('banned-english.md');
    const crlfContent = `Intro line, clean.\r\n${lfContent.replace(/\n/g, '\r\n')}`;

    const violations = scanCopy([{ path: 'crlf.md', content: crlfContent }], BANNED_CLAIMS);

    // The banned content is now on line 2 (line 1 is the clean CRLF intro).
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.line).toBe(2);
    }
  });

  it('a_thousand_repeated_banned_lines_are_all_reported_and_stay_fast', () => {
    const claim = BANNED_CLAIMS[0] as string;
    const line = `This service offers ${claim} to everyone.`;
    const content = Array.from({ length: 1000 }, () => line).join('\n');

    const start = performance.now();
    const violations = scanCopy([{ path: 'huge.md', content }], BANNED_CLAIMS);
    const elapsedMs = performance.now() - start;

    expect(violations).toHaveLength(1000);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('an_all_caps_variant_of_a_banned_claim_is_still_caught_case_insensitively', () => {
    const claim = BANNED_CLAIMS[0] as string;
    const content = `We proudly offer ${claim.toUpperCase()} to every customer.`;

    const violations = scanCopy([{ path: 'shout.md', content }], BANNED_CLAIMS);

    expect(violations.some((violation) => violation.message.includes(claim))).toBe(true);
  });

  // accepted limitation: a raw substring scan over file TEXT cannot catch a
  // banned claim split across a template-literal/string concatenation -
  // documented here, not silently uncovered.
  it('a_banned_claim_split_across_a_string_concatenation_evades_the_scanner_accepted_limitation', () => {
    const claim =
      BANNED_CLAIMS.find((entry) => entry.includes(' ')) ?? (BANNED_CLAIMS[0] as string);
    const mid = Math.floor(claim.length / 2);
    const first = claim.slice(0, mid);
    const second = claim.slice(mid);
    const content = `export const copy = '${first}' + '${second}';`;

    const violations = scanCopy([{ path: 'split.ts', content }], BANNED_CLAIMS);

    expect(violations).toEqual([]);
  });

  // --- P17 Unit U2 (step 2): the two new copy files, real-tree proof -----

  it('a_safe_mode_string_without_the_disclaimer_fails', () => {
    // (a) a fixture file containing the Safe-Mode token without
    // SAFE_MODE_DISCLAIMER produces a violation (same fixture pair
    // check-copy.ts's own module doc references).
    const badPath = `${FIXTURES_DIR}/safe-mode-no-disclaimer.ts`;
    const violations = scanCopy(
      [{ path: badPath, content: readFixture('safe-mode-no-disclaimer.ts') }],
      BANNED_CLAIMS,
    );
    expect(violations.some((violation) => violation.file === badPath)).toBe(true);

    // (b) the REAL scan (runCheckCopy, over the actual repo tree) finds zero
    // violations in the two new P17 copy files (they ship the required
    // disclaimer text correctly). NB: never spell the pacing feature's
    // user-facing name in this comment — check-copy scans this file too.
    const result = runCheckCopy();
    const scannedNotificationsCopy = result.violations.filter(
      (violation) => violation.file === 'packages/domain/src/copy/notifications.ts',
    );
    const scannedInstanceCardCopy = result.violations.filter(
      (violation) => violation.file === 'packages/domain/src/copy/instance-card.ts',
    );
    expect(scannedNotificationsCopy).toEqual([]);
    expect(scannedInstanceCardCopy).toEqual([]);
  });

  it('the_real_scan_matches_both_new_p17_copy_files_with_a_non_zero_matched_file_count', () => {
    const matchedFiles = resolveFiles(COPY_GLOBS);
    expect(matchedFiles.length).toBeGreaterThan(0);
    expect(matchedFiles).toContain('packages/domain/src/copy/notifications.ts');
    expect(matchedFiles).toContain('packages/domain/src/copy/instance-card.ts');
  });

  // --- P21 Unit U6b (step 7) / C1 fix round: the inbound admission shed
  // notice - reads the LIVE catalogue value (a `+`-joined multi-line string
  // literal), never just the fixture copy, so catalogue drift is caught.
  function extractCatalogueValue(catalogueSource: string, key: string): string {
    const keyRe = new RegExp(`'${key}':\\s*([\\s\\S]*?),\\n`, 'm');
    const match = keyRe.exec(catalogueSource);
    if (!match) {
      throw new Error(`catalogue key '${key}' not found - cannot verify live inbound copy`);
    }
    const valueSource = match[1] as string;
    const segments = Array.from(valueSource.matchAll(/'((?:\\.|[^'\\])*)'/g)).map(
      (m) => m[1] as string,
    );
    if (segments.length === 0) {
      throw new Error(`catalogue key '${key}' had no quoted string segments`);
    }
    return segments.join('');
  }

  function assertHonestShedCopy(value: string): void {
    expect(value).toContain('not being checked');
    expect(value).toContain('up to the per-number limit');
    expect(value.toLowerCase()).not.toContain('all receipts');
    expect(value.toLowerCase()).not.toContain('every receipt is recorded');
    expect(value.toLowerCase()).not.toContain('complete');
    expect(value.toLowerCase().replace('does not guarantee', '')).not.toContain('guarantee'); // stem
  }

  it('inbound_copy_states_the_shed_limit_honestly', () => {
    const enPath = 'packages/i18n/src/catalogues/en.ts';
    const hiPath = 'packages/i18n/src/catalogues/hi.ts';
    const enContent = readFileSync(path.join(REPO_ROOT, enPath), 'utf8');
    const hiContent = readFileSync(path.join(REPO_ROOT, hiPath), 'utf8');
    expect(enContent).toContain("'inbound.shed.notice'");
    expect(hiContent).toContain("'inbound.shed.notice'");

    const liveEnValue = extractCatalogueValue(enContent, 'inbound.shed.notice');
    const liveHiValue = extractCatalogueValue(hiContent, 'inbound.shed.notice');

    // scanCopy on the LIVE values (not the fixture).
    const liveViolations = scanCopy(
      [
        { path: enPath, content: liveEnValue },
        { path: hiPath, content: liveHiValue },
      ],
      BANNED_CLAIMS,
    );
    expect(liveViolations).toEqual([]);
    assertHonestShedCopy(liveEnValue);

    // Fixture drift check: the fixture must still contain both live strings.
    const fixtureContent = readFixture('inbound-shed-honest.md');
    expect(fixtureContent).toContain(liveEnValue);
    expect(fixtureContent).toContain(liveHiValue);
  });
});
