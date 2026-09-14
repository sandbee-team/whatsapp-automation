import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HEALTH_BAND_WRITER_ALLOW_LIST,
  HEALTH_STATE_WRITER_ALLOW_LIST,
  HEALTH_WRITERS_GLOBS,
  runCheckHealthWriters,
  scanHealthWriters,
} from '../check-health-writers.js';
import { resolveFiles } from './scan-config.js';
import { REPO_ROOT } from './registry.js';

/**
 * check-health-writers.test.ts (P16 Unit E, step 10) - proves the single-
 * writer guard: only the pinned `whatsapp_instances.health_state` and
 * `instance_pacing_state.health_score`/`health_band` writer allow-lists may
 * write those columns. Fixtures live under
 * `scripts/guards/__fixtures__/health-writers/` (excluded from the guard's
 * own real repo scan by `CONTENT_EXCLUSIONS`).
 */

const FIXTURES_DIR = 'scripts/guards/__fixtures__/health-writers';

function readFixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, FIXTURES_DIR, name), 'utf8');
}

describe('check-health-writers (P16 Unit E, step 10)', () => {
  it('only_the_health_module_writes_health_state_or_health_band', () => {
    const stateFilePath = `${FIXTURES_DIR}/bad-health-state-write.ts`;
    const bandFilePath = `${FIXTURES_DIR}/bad-health-band-write.ts`;
    const files = [
      { path: stateFilePath, content: readFixture('bad-health-state-write.ts') },
      { path: bandFilePath, content: readFixture('bad-health-band-write.ts') },
    ];

    const violations = scanHealthWriters(files);

    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations.some((v) => v.file === stateFilePath)).toBe(true);
    expect(violations.some((v) => v.file === bandFilePath)).toBe(true);
  });

  it('a_read_only_where_clause_reference_is_never_flagged', () => {
    const filePath = `${FIXTURES_DIR}/clean-read-only.ts`;
    const files = [{ path: filePath, content: readFixture('clean-read-only.ts') }];

    const violations = scanHealthWriters(files);

    expect(violations).toHaveLength(0);
  });

  it('a_pinned_allow_listed_writer_scanned_under_its_real_path_is_not_flagged', () => {
    const realPath = HEALTH_STATE_WRITER_ALLOW_LIST[0]!;
    const files = [
      {
        path: realPath,
        content: `UPDATE whatsapp_instances SET health_state = 'paused' WHERE id = $1`,
      },
    ];

    const violations = scanHealthWriters(files);

    expect(violations).toHaveLength(0);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckHealthWriters();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('the_globs_match_at_least_one_real_file_today', () => {
    const files = resolveFiles(HEALTH_WRITERS_GLOBS);
    expect(files.length).toBeGreaterThan(0);
  });

  it('both_allow_lists_are_non_empty', () => {
    expect(HEALTH_STATE_WRITER_ALLOW_LIST.length).toBeGreaterThan(0);
    expect(HEALTH_BAND_WRITER_ALLOW_LIST.length).toBeGreaterThan(0);
  });
});
