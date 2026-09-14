import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXCLUSIONS,
  CONTENT_EXCLUSIONS,
  GUARDS,
  REPO_ROOT,
  SCAN_GLOBS,
  parsePhaseStatus,
  resolveFiles,
} from './registry.js';
import { CI_STEPS } from '../ci-steps.js';

// Note: planning/meta files at repo root (plan/, .claude/, CLAUDE.md, MASTER-PLAN.md,
// plan.html, my-prompt.md, .gitignore) are outside SCAN_GLOBS by construction - internal
// planning docs, never shipped; the scanned universe is the ADR 0014 tree.

describe('guard registry meta-assertions', () => {
  it('every_registered_guard_matches_at_least_one_file', () => {
    const readmeText = readFileSync(path.join(REPO_ROOT, 'plan', 'README.md'), 'utf8');
    const phaseStatus = parsePhaseStatus(readmeText);

    for (const guard of GUARDS) {
      const files = resolveFiles(guard.globs);
      if (files.length > 0) {
        continue;
      }
      expect(
        guard.activatesIn,
        `guard "${guard.name}" matches 0 files and declares no activatesIn phase`,
      ).toBeDefined();
      const status = guard.activatesIn ? phaseStatus.get(guard.activatesIn) : undefined;
      expect(
        status,
        `guard "${guard.name}" declares activatesIn "${guard.activatesIn}" which is not a known phase in plan/README.md`,
      ).toBeDefined();
      expect(
        status,
        `guard "${guard.name}" declares activatesIn "${guard.activatesIn}" but that phase is already "done" - the guard must now match a real file`,
      ).not.toBe('done');
    }
  });

  it('guard_scan_exclusions_are_exactly_demo_memory_and_fixtures', () => {
    expect(CONTENT_EXCLUSIONS).toEqual(['demo/**', '.memory/**', 'scripts/guards/__fixtures__/**']);
    expect(ARTIFACT_EXCLUSIONS).toEqual([
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'website/out/**',
      '**/.next/**',
    ]);
    expect(SCAN_GLOBS).toEqual([
      'app/**',
      'admin/**',
      'website/**',
      'packages/**',
      'db/**',
      'infra/**',
      'scripts/**',
      'docs/**',
    ]);
  });

  it('ci_ps1_and_ci_sh_run_the_same_ordered_steps', () => {
    const ps1 = readFileSync(path.join(REPO_ROOT, 'scripts', 'ci.ps1'), 'utf8');
    const sh = readFileSync(path.join(REPO_ROOT, 'scripts', 'ci.sh'), 'utf8');

    // Both wrappers must delegate to the single ordered step list...
    expect(ps1).toContain('scripts/ci-steps.ts');
    expect(sh).toContain('scripts/ci-steps.ts');

    // ...and must contain NONE of the individual step commands, so steps can
    // only ever live in scripts/ci-steps.ts (no drift between the two gates).
    // Matches the FULL command string ("pnpm run lint", "pnpm run build"),
    // not just the bare word after "pnpm run" - a bare-word check like
    // "lint" or "build" would also match unrelated substrings that have
    // nothing to do with the step command (e.g. an incidental "build" inside
    // a sentence), which is neither what this assertion means to prove nor a
    // reliable way to prove it.
    for (const step of CI_STEPS) {
      expect(ps1, `ci.ps1 must not hardcode step command "${step.command}"`).not.toContain(
        step.command,
      );
      expect(sh, `ci.sh must not hardcode step command "${step.command}"`).not.toContain(
        step.command,
      );
    }
  });

  it('every_workspace_main_points_at_src', () => {
    // Guard-evasion tripwire (reviewer NOTE 2): dependency-cruiser's config
    // excludes dist/ from the scan (fixed CRITICAL 1). If any workspace
    // package.json's "main" is ever edited back to "./dist/index.js", that
    // exclusion silently drops the package from the dependency graph again.
    // @wp/config ships no src/ (config-only package) and is skipped.
    const packageJsonPaths = fg.sync(
      [
        'app/*/package.json',
        'admin/*/package.json',
        'website/package.json',
        'packages/*/package.json',
        'db/package.json',
      ],
      { cwd: REPO_ROOT, onlyFiles: true },
    );

    expect(packageJsonPaths.length).toBeGreaterThan(0);

    for (const relativePath of packageJsonPaths) {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')) as {
        name?: string;
        main?: string;
      };

      if (pkg.name === '@wp/config') continue;

      expect(pkg.main, `${relativePath} has no "main" field`).toBeDefined();
      expect(
        pkg.main?.startsWith('./src/'),
        `${relativePath} "main" is "${String(pkg.main)}" - must start with "./src/" (dist/ is excluded from the dependency-cruiser scan)`,
      ).toBe(true);
    }
  });

  // --- Edge-case pass (session C2) ----------------------------------------

  describe('parsePhaseStatus edge cases', () => {
    it('a_malformed_row_missing_the_status_cell_is_simply_not_parsed', () => {
      const malformed = '| P00 | `workspace-guards-and-domain` |\n';
      const statuses = parsePhaseStatus(malformed);
      expect(statuses.has('P00')).toBe(false);
    });

    it('an_empty_readme_text_produces_an_empty_map', () => {
      expect(parsePhaseStatus('').size).toBe(0);
    });

    it('a_row_for_an_unknown_phase_id_is_simply_absent_from_the_map', () => {
      const readme = '| P00 | `workspace-guards-and-domain` | done | notes |\n';
      const statuses = parsePhaseStatus(readme);
      expect(statuses.get('P99')).toBeUndefined();
    });

    it('a_status_value_outside_todo_in_progress_done_is_not_matched_by_the_row_pattern', () => {
      // "blocked" is not one of the three literal alternatives the row
      // pattern accepts - such a row is simply not captured, never
      // silently coerced to "todo".
      const readme = '| P00 | `workspace-guards-and-domain` | blocked | notes |\n';
      const statuses = parsePhaseStatus(readme);
      expect(statuses.has('P00')).toBe(false);
    });
  });

  describe('a guard declaring activatesIn for a phase absent from plan/README.md fails loudly', () => {
    it('meta_assertion_logic_fails_rather_than_treating_an_unknown_phase_as_perpetually_pending', () => {
      // Replicates meta-assert.ts's exact activatesInOk computation (see
      // scripts/guards/meta-assert.ts) against a synthetic guard + a
      // synthetic README that never mentions the declared phase - proving
      // the "unknown activatesIn phase" case is a hard failure, not a
      // silent pass, without spawning the CLI (which calls process.exit).
      const readmeWithoutP97 = '| P00 | `workspace-guards-and-domain` | todo | notes |\n';
      const phaseStatus = parsePhaseStatus(readmeWithoutP97);

      const guard = { name: 'fake-guard', activatesIn: 'P97' as const };
      const status = guard.activatesIn ? phaseStatus.get(guard.activatesIn) : undefined;
      const activatesInOk =
        guard.activatesIn !== undefined && status !== undefined && status !== 'done';

      expect(activatesInOk).toBe(false);
    });

    it('meta_assertion_logic_also_fails_when_the_declared_phase_is_already_done', () => {
      const readmeWithDoneP00 = '| P00 | `workspace-guards-and-domain` | done | notes |\n';
      const phaseStatus = parsePhaseStatus(readmeWithDoneP00);

      const guard = { name: 'fake-guard', activatesIn: 'P00' as const };
      const status = guard.activatesIn ? phaseStatus.get(guard.activatesIn) : undefined;
      const activatesInOk =
        guard.activatesIn !== undefined && status !== undefined && status !== 'done';

      expect(activatesInOk).toBe(false);
    });
  });
});
