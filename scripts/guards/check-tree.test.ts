import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTreeEntries, checkScriptsEmittedArtifacts, checkTree } from '../check-tree.js';
import { REPO_ROOT } from './registry.js';

/**
 * Fixture proof for check-tree.ts (P00 step 6). `checkTree` is a pure
 * function over a flat entry listing - no filesystem access - so most cases
 * are fed synthetic listings; only `the_real_repo_tree_is_clean` reads the
 * actual repo via `buildTreeEntries`.
 */
describe('check-tree (P00 step 6)', () => {
  it('a_top_level_folder_outside_adr_0014_is_rejected', () => {
    const entries = [...readdirSync(REPO_ROOT), 'src'];

    const violations = checkTree(entries);

    expect(violations.some((violation) => violation.path === 'src')).toBe(true);
  });

  it('an_unknown_second_level_entry_under_app_or_admin_is_rejected', () => {
    const violations = checkTree(['app/rogue', 'admin/rogue']);

    expect(violations.map((violation) => violation.path)).toEqual(['app/rogue', 'admin/rogue']);
  });

  it('an_unknown_second_level_entry_under_db_or_infra_is_rejected', () => {
    const violations = checkTree(['db/rogue', 'infra/rogue']);

    expect(violations.map((violation) => violation.path)).toEqual(['db/rogue', 'infra/rogue']);
  });

  it('build_artifacts_under_checked_dirs_are_not_tree_violations', () => {
    const violations = checkTree([
      'db/node_modules',
      'db/dist',
      'db/tsconfig.tsbuildinfo',
      'app/backend',
      'admin/frontend',
    ]);

    expect(violations).toEqual([]);
  });

  it('the_dev_only_secrets_directory_is_allow_listed_at_top_level', () => {
    const violations = checkTree(['.secrets']);
    expect(violations).toEqual([]);
  });

  it('an_empty_entry_list_produces_no_violations', () => {
    expect(checkTree([])).toEqual([]);
  });

  it('a_thousand_synthetic_entries_are_scanned_and_stay_fast', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => `app/rogue-${String(i)}`);

    const start = performance.now();
    const violations = checkTree(entries);
    const elapsedMs = performance.now() - start;

    expect(violations).toHaveLength(1000);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('entries_three_levels_deep_are_out_of_scope_and_never_flagged', () => {
    // checkTree only inspects top-level and one-level-deep (app/admin/db/infra)
    // entries by construction - anything deeper is simply not in its universe.
    const violations = checkTree(['app/backend/src/index.ts']);
    expect(violations).toEqual([]);
  });

  it('the_real_repo_tree_is_clean', () => {
    const violations = checkTree(buildTreeEntries(REPO_ROOT));
    expect(violations).toEqual([]);
  });
});

describe('checkScriptsEmittedArtifacts (M6 - accidental tsc emit under scripts/)', () => {
  it('a_checked_in_js_file_under_scripts_is_a_violation', () => {
    const violations = checkScriptsEmittedArtifacts(['scripts/foo.js']);
    expect(violations.map((violation) => violation.path)).toEqual(['scripts/foo.js']);
  });

  it('a_checked_in_d_ts_or_map_file_under_scripts_is_a_violation', () => {
    const violations = checkScriptsEmittedArtifacts(['scripts/foo.d.ts', 'scripts/foo.js.map']);
    expect(violations.map((violation) => violation.path)).toEqual([
      'scripts/foo.d.ts',
      'scripts/foo.js.map',
    ]);
  });

  it('a_guard_fixture_js_file_is_allowed', () => {
    const violations = checkScriptsEmittedArtifacts(['scripts/guards/__fixtures__/x.js']);
    expect(violations).toEqual([]);
  });

  it('gen_key_ring_mjs_is_allowed', () => {
    const violations = checkScriptsEmittedArtifacts(['scripts/gen-key-ring.mjs']);
    expect(violations).toEqual([]);
  });

  it('an_empty_entry_list_produces_no_violations', () => {
    expect(checkScriptsEmittedArtifacts([])).toEqual([]);
  });
});
