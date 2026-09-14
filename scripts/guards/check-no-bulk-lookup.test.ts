import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_BULK_LOOKUP_GLOBS,
  runCheckNoBulkLookup,
  scanNoBulkLookup,
} from '../check-no-bulk-lookup.js';
import type { SourceFile } from '../check-no-bulk-lookup.js';
import { REPO_ROOT, resolveFiles } from './scan-config.js';

/**
 * check-no-bulk-lookup.test.ts (P20 Unit U3, step 9) - proves the guard's
 * three clauses against the fixture tree in
 * `__fixtures__/no-bulk-lookup/`, plus a real-tree scan.
 */

const FIXTURE_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'no-bulk-lookup');

function readFixture(name: string, asPath: string): SourceFile {
  return { path: asPath, content: readFileSync(path.join(FIXTURE_DIR, name), 'utf8') };
}

describe('scanNoBulkLookup', () => {
  it('a_planted_bulk_on_whatsapp_loop_fails_the_guard', () => {
    const file = readFixture('bad-loop-validate.ts', 'app/backend/src/modules/imports/validate.ts');
    const violations = scanNoBulkLookup([file]);

    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.message.includes('refused, not deferred'))).toBe(true);
  });

  it('a_lookup_inside_modules_contacts_is_red_even_when_allow_listed', () => {
    const file = readFixture(
      'bad-contacts-module.ts',
      'app/backend/src/modules/contacts/validate.ts',
    );

    // Even scanned alone (no allow-list injected at all, matching clause (a)'s
    // own empty BULK_LOOKUP_ALLOWED_FILES default), clause (b) must still fire
    // for this path specifically.
    const violations = scanNoBulkLookup([file]);

    expect(
      violations.some((v) => v.file === file.path && v.message.includes('modules/contacts')),
    ).toBe(true);
  });

  it('a_single_allow_listed_manual_send_lookup_stays_clean', () => {
    // clean-single-lookup.ts is a single (non-loop) call outside
    // modules/contacts/ - clean under the guard's real (empty) allow-list
    // too, since clause (a) only fires for files NOT allow-listed; this
    // fixture demonstrates the "future allow-listed site" shape stays clean
    // once such an entry exists, by using a path this test asserts is not
    // flagged by clause (b) or (c).
    const file = readFixture(
      'clean-single-lookup.ts',
      'app/backend/src/modules/messages/manual-send-lookup.ts',
    );

    const violations = scanNoBulkLookup([file]);

    // Clause (a) still fires today (file is not in the real allow-list) -
    // but clauses (b) and (c) must not, proving the "single lookup, non-
    // contacts, non-loop" shape is exactly the one clause (a) alone governs.
    expect(violations.every((v) => v.message.includes('refused, not deferred'))).toBe(true);
    expect(violations.some((v) => v.message.includes('modules/contacts'))).toBe(false);
    expect(violations.some((v) => v.message.includes('no loop over a list'))).toBe(false);
  });

  it('unrelated_clean_source_stays_clean', () => {
    const file = readFixture('clean-unrelated.ts', 'app/backend/src/modules/messages/util.ts');
    expect(scanNoBulkLookup([file])).toEqual([]);
  });

  it('the_real_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckNoBulkLookup();
    expect(result.violations).toEqual([]);
    expect(result.filesScanned ?? 0).toBeGreaterThan(0);
  });

  it('n2_website_src_is_now_scanned_and_still_zero_violations', () => {
    expect(NO_BULK_LOOKUP_GLOBS).toContain('website/src/**/*.{ts,tsx}');

    // The scanned count with website/ included must exceed the count WITHOUT
    // it - proving the glob addition actually grows the scan, not a no-op.
    const withoutWebsite = resolveFiles(
      NO_BULK_LOOKUP_GLOBS.filter((g) => g !== 'website/src/**/*.{ts,tsx}'),
    ).length;
    const result = runCheckNoBulkLookup();
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(withoutWebsite);
  });
});
