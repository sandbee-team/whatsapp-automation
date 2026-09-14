import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSECURE_TLS_GLOBS, runCheckNoInsecureTls } from '../check-no-insecure-tls.js';
import { REPO_ROOT, resolveFiles } from '../guards/scan-config.js';
import type { SourceFile } from '../check-no-insecure-tls.js';

const FIXTURES_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'insecure-tls');

function readFixture(relativePath: string): SourceFile {
  return {
    path: relativePath,
    content: readFileSync(path.join(FIXTURES_DIR, relativePath), 'utf8'),
  };
}

describe('check-no-insecure-tls (P15 Unit U3)', () => {
  it('rejectUnauthorized_false_anywhere_outside_tests_fails_the_guard', () => {
    const bad = readFixture('bad-reject-unauthorized.ts');
    const result = runCheckNoInsecureTls([bad]);

    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0]?.file).toBe('bad-reject-unauthorized.ts');
    expect(result.violations[0]?.message).toContain('rejectUnauthorized');
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED_anywhere_outside_tests_fails_the_guard', () => {
    const bad = readFixture('bad-env-var.ts');
    const result = runCheckNoInsecureTls([bad]);

    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0]?.file).toBe('bad-env-var.ts');
    expect(result.violations[0]?.message).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('a_clean_fixture_produces_zero_violations', () => {
    const clean = readFixture('clean.ts');
    const result = runCheckNoInsecureTls([clean]);

    expect(result.violations).toEqual([]);
  });

  it('a_test_file_using_rejectUnauthorized_false_is_exempt', () => {
    const testFile: SourceFile = {
      path: 'app/backend/src/platform/http/some.test.ts',
      content: 'const opts = { rejectUnauthorized: false };',
    };
    const result = runCheckNoInsecureTls([testFile]);
    expect(result.violations).toEqual([]);
  });

  it('a_fixtures_directory_file_is_exempt', () => {
    const fixtureFile: SourceFile = {
      path: 'app/backend/src/platform/http/__fixtures__/bad.ts',
      content: 'const opts = { rejectUnauthorized: false };',
    };
    const result = runCheckNoInsecureTls([fixtureFile]);
    expect(result.violations).toEqual([]);
  });

  it('resolveFiles_matches_at_least_one_real_file_in_the_shipped_tree', () => {
    const files = resolveFiles(INSECURE_TLS_GLOBS);
    expect(files.length).toBeGreaterThan(0);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const files = resolveFiles(INSECURE_TLS_GLOBS).map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }));
    const result = runCheckNoInsecureTls(files);

    expect(files.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});
