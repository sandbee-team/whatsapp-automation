import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RAW_HEX_GLOBS, runCheckNoRawHex } from '../check-no-raw-hex.js';
import { REPO_ROOT, resolveFiles } from '../guards/scan-config.js';
import type { SourceFile } from '../check-no-raw-hex.js';

const FIXTURES_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'raw-hex');

function readFixture(relativePath: string): SourceFile {
  return {
    path: relativePath,
    content: readFileSync(path.join(FIXTURES_DIR, relativePath), 'utf8'),
  };
}

describe('check-no-raw-hex (P05 step 3)', () => {
  it('a_raw_hex_colour_in_packages_ui_fails_the_guard', () => {
    const bad = readFixture('packages/ui/src/bad.tsx');
    const result = runCheckNoRawHex([bad]);

    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0]?.file).toBe('packages/ui/src/bad.tsx');
  });

  it('a_clean_fixture_produces_zero_violations', () => {
    const clean = readFixture('packages/ui/src/clean.tsx');
    const result = runCheckNoRawHex([clean]);

    expect(result.violations).toEqual([]);
  });

  it('resolveFiles_matches_at_least_one_real_file_in_the_shipped_tree', () => {
    const files = resolveFiles(RAW_HEX_GLOBS);
    expect(files.length).toBeGreaterThan(0);
  });

  it('two_raw_hex_colours_on_one_line_are_reported_as_two_separate_violations', () => {
    // MIN-3: the scanner must report one violation PER MATCH (`matchAll`),
    // not one per LINE (a single `.exec()` call only ever finds the first
    // match on a line) - a line with two distinct colour literals must
    // surface both, not silently swallow the second.
    const fixture = readFixture('packages/ui/src/two-colours-one-line.tsx');
    const result = runCheckNoRawHex([fixture]);

    const hexViolations = result.violations.filter((v) => v.message.includes('raw hex colour'));
    expect(hexViolations).toHaveLength(2);
    expect(hexViolations[0]?.message).toContain('#ff0000');
    expect(hexViolations[1]?.message).toContain('#00ff00');
    expect(hexViolations.every((v) => v.line === 2)).toBe(true);
  });
});
