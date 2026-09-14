import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * enqueue.api-boundary.integration.test.ts (P11 Unit U3, split from
 * `enqueue.integration.test.ts` for max-lines discipline - the same
 * `claim.integration.test.ts` / `claim.race.integration.test.ts` split
 * idiom) - `the_api_process_cannot_reach_the_transport` (phase file,
 * mandatory test 8): proves `api-never-imports-provider` still trips
 * against the REAL `roles/api.ts` file, not just the fixture tree
 * `scripts/guards/depcruise.test.ts` scans. Named `.integration.test.ts`
 * (not `.test.ts`) because it shells out to the real `depcruise` binary -
 * not a Postgres/Redis dependency, but the same "real external process"
 * reasoning places it alongside the DB integration suite rather than the
 * root unit run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const API_ROLE_PATH = path.join(REPO_ROOT, 'app', 'backend', 'src', 'roles', 'api.ts');
const DEPCRUISE_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'depcruise.CMD');
const CONFIG_PATH = path.join(REPO_ROOT, '.dependency-cruiser.cjs');

function runDepcruise(): { violations: { rule: { name: string } }[] } {
  let stdout: string;
  try {
    stdout = execFileSync(
      DEPCRUISE_BIN,
      [
        'app/backend/src/roles/api.ts',
        '--config',
        CONFIG_PATH,
        '--output-type',
        'json',
        '--validate',
      ],
      // `.CMD` shims require shell mode on Windows (Node refuses to spawn
      // a batch file directly since the CVE-2024-27980 fix) - depcruise's
      // own bin is a `.CMD` wrapper there.
      { cwd: REPO_ROOT, encoding: 'utf8', shell: true },
    );
  } catch (err) {
    // depcruise exits non-zero when a forbidden-rule violation is found -
    // its JSON report is still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  const parsed = JSON.parse(stdout) as { summary: { violations: { rule: { name: string } }[] } };
  return { violations: parsed.summary.violations };
}

describe('the_api_process_cannot_reach_the_transport', () => {
  it('depcruise still trips api-never-imports-provider on a planted import', () => {
    const original = readFileSync(API_ROLE_PATH, 'utf8');
    try {
      // The planted specifier must resolve to a REAL file - dependency-
      // cruiser reports an unresolved import's `resolved` path as the raw,
      // un-normalized specifier (`../provider/baileys/send.js`, never the
      // repo-root-relative form the rule's `to.path` regex matches), so a
      // planted import to a non-existent module silently never trips the
      // rule at all (verified live). `adapter.ts` already exists under
      // `provider/baileys/` (earlier phases) - this only ADDS an import
      // line to `roles/api.ts`, never a new file, and restores the
      // original content in `finally` either way.
      const planted = `${original}\nimport '../provider/baileys/adapter.js';\n`;
      writeFileSync(API_ROLE_PATH, planted, 'utf8');

      const { violations } = runDepcruise();
      const hit = violations.some((v) => v.rule.name === 'api-never-imports-provider');
      expect(hit).toBe(true);
    } finally {
      writeFileSync(API_ROLE_PATH, original, 'utf8');
    }
  });

  it('depcruise reports zero violations against the real, unplanted file', () => {
    const { violations } = runDepcruise();
    const hit = violations.some((v) => v.rule.name === 'api-never-imports-provider');
    expect(hit).toBe(false);
  });
});
