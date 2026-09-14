import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_STEPS } from './ci-steps.js';
import { REPO_ROOT } from './guards/scan-config.js';

/**
 * Fixture-free proof that `tsx scripts/ci-steps.ts list` prints exactly
 * `CI_STEPS`, one "<name> -> <command>" line per step, in order - the source
 * of truth `ci_ps1_and_ci_sh_run_the_same_ordered_steps` (meta.test.ts)
 * checks the wrappers never hardcode a step; this checks the `list` CLI
 * surface itself matches the exported array exactly.
 */
describe('ci-steps.ts list output', () => {
  it('list_mode_output_matches_ci_steps_exactly_in_order', () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'ci-steps.ts');
    const result = spawnSync('pnpm', ['exec', 'tsx', scriptPath, 'list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(CI_STEPS.length);
    lines.forEach((line, index) => {
      const step = CI_STEPS[index];
      expect(line).toBe(`${step?.name} -> ${step?.command}`);
    });
  });

  it('an_unknown_mode_argument_exits_non_zero', () => {
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'ci-steps.ts');
    const result = spawnSync('pnpm', ['exec', 'tsx', scriptPath, 'bogus-mode'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown mode');
  });
});
