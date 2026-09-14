import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './registry.js';

const execFileAsync = promisify(execFile);

/**
 * Entry-point smoke test (P00 follow-up).
 *
 * `registry.ts`, `check-tree.ts` and `check-tenant-scope.ts` used to form a
 * real circular import. The cycle only crashed when `check-tenant-scope.ts`
 * was the CLI *entry* module (`tsx scripts/check-tenant-scope.ts`): its own
 * top-level `export const TENANT_SCOPE_GLOBS` hadn't run yet when
 * `registry.ts`, imported earlier in the same file, tried to read it while
 * building `GUARDS` - a TDZ `ReferenceError`. Every other test in this repo
 * (`check-tree.test.ts`, `check-tenant-scope.test.ts`, `meta.test.ts`, ...)
 * only imports pure functions from these modules, so module load/evaluation
 * order - and therefore this bug - was never exercised. This test spawns
 * each guard CLI as its own process/entry module, the same way CI and a
 * developer's terminal do, so an entry-point-dependent circular import
 * cannot regress silently again.
 *
 * Spawns run concurrently (`it.concurrent.each` + a promisified `execFile`)
 * instead of serially via `spawnSync` - each guard CLI is an independent
 * process with no shared state, so there is no correctness reason to wait
 * for one to exit before starting the next; this was most of the ~1-2s x 5
 * serial cost that made this file the biggest contributor to the root unit
 * suite's runtime.
 */
describe('every guard CLI runs standalone as its own entry module', () => {
  it.concurrent.each([
    ['scripts/check-tree.ts'],
    ['scripts/check-tenant-scope.ts'],
    ['scripts/check-send-origin.ts'],
    ['scripts/check-copy.ts'],
    ['scripts/guards/meta-assert.ts'],
    ['scripts/check-single-claim.ts'],
    ['scripts/check-serialisation-boundary.ts'],
  ])('every_guard_cli_runs_as_its_own_entry_module (%s)', async (relativeScriptPath) => {
    let status: number | string | null = 0;
    let stdout: string;
    let stderr: string;

    try {
      const result = await execFileAsync('pnpm', ['exec', 'tsx', relativeScriptPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: true,
        timeout: 30000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const execError = error as {
        code?: number | string | null;
        stdout?: string;
        stderr?: string;
      };
      status = execError.code ?? 1;
      stdout = execError.stdout ?? '';
      stderr = execError.stderr ?? '';
    }

    expect(
      status,
      `expected exit 0 for \`tsx ${relativeScriptPath}\` on a clean tree, got ${String(
        status,
      )}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    ).toBe(0);
  });
});
