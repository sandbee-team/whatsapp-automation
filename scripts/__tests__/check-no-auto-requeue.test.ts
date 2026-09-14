import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_AUTO_REQUEUE_EXEMPT_PATHS,
  NO_AUTO_REQUEUE_GLOBS,
  runCheckNoAutoRequeue,
  scanNoAutoRequeue,
} from '../check-no-auto-requeue.js';
import { resolveFiles } from '../guards/scan-config.js';
import { REPO_ROOT } from '../guards/registry.js';

/**
 * check-no-auto-requeue.ts (P12 Unit U5, step 8) - proves only
 * `unresolved.service.ts` may contain an UPDATE moving a job OUT of
 * `blocked_needs_review`, and only inside a function taking an actor.
 * Fixtures live under `scripts/guards/__fixtures__/no-auto-requeue/`
 * (excluded from the guard's own real repo scan by `CONTENT_EXCLUSIONS`),
 * read with `readFileSync`, passed to the PURE `scanNoAutoRequeue` - never
 * the CLI (which calls `process.exit`), matching
 * `check-single-claim.test.ts`'s idiom exactly.
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/no-auto-requeue';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-no-auto-requeue (P12 Unit U5, step 8)', () => {
  it('a_second_path_out_of_blocked_needs_review_fails_the_guard', () => {
    const filePath = `${FIXTURES_DIR}/bad-second-path-out-of-blocked.ts`;
    const files = [{ path: filePath, content: readFixture('bad-second-path-out-of-blocked.ts') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.file === filePath)).toBe(true);
  });

  it('the_real_exempt_shape_with_a_top_level_actor_parameter_is_not_flagged', () => {
    // Scanned AS IF it were the exempt path - proves the exemption logic
    // itself (not just "this fixture happens to live outside the glob").
    const filePath = NO_AUTO_REQUEUE_EXEMPT_PATHS[0];
    const files = [{ path: filePath, content: readFixture('clean-real-shape.ts') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations).toHaveLength(0);
  });

  it('the_second_exempt_path_restamp_service_is_also_recognised', () => {
    // P23 Unit U6 addition - the SAME clean fixture shape, scanned as if it
    // were the second exempt path, proves the array-based exemption (not
    // just the first entry) actually works.
    const filePath = NO_AUTO_REQUEUE_EXEMPT_PATHS[1];
    const files = [{ path: filePath, content: readFixture('clean-real-shape.ts') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations).toHaveLength(0);
  });

  it('a_transition_inside_the_exempt_file_but_with_no_actor_parameter_is_still_flagged', () => {
    const filePath = NO_AUTO_REQUEUE_EXEMPT_PATHS[0];
    const files = [{ path: filePath, content: readFixture('bad-no-actor-in-exempt-file.ts') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_for_update_skip_locked_row_lock_clause_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean-for-update-skip-locked.sql`;
    const files = [{ path: filePath, content: readFixture('clean-for-update-skip-locked.sql') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations).toHaveLength(0);
  });

  it('a_real_transition_surrounded_by_comment_noise_is_still_flagged', () => {
    const filePath = `${FIXTURES_DIR}/bad-comment-noise.sql`;
    const files = [{ path: filePath, content: readFixture('bad-comment-noise.sql') }];

    const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

    expect(violations.length).toBeGreaterThan(0);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckNoAutoRequeue();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('the_globs_match_at_least_one_real_file_today', () => {
    const files = resolveFiles(NO_AUTO_REQUEUE_GLOBS);
    expect(files.length).toBeGreaterThan(0);
  });
});
