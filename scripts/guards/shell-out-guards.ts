import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './scan-config.js';
import type { GuardResult, GuardViolation } from './scan-config.js';

/**
 * The two guard runners that shell out to an external CLI (depcruise,
 * eslint) and parse its JSON output - kept out of `registry.ts` to stay
 * under its own `max-lines` lint budget (same reason `run-source-guards.ts`
 * exists).
 */

interface DepcruiseViolation {
  from: string;
  to: string;
  rule: { name: string; severity?: string };
}

interface DepcruiseCruiseResult {
  summary?: { violations?: DepcruiseViolation[] };
}

/**
 * Shells out to the `depcruise` CLI (dependency-cruiser) with the repo's
 * `.dependency-cruiser.cjs` config against the five real source trees -
 * never `scripts/guards/__fixtures__/**`, which is excluded by construction
 * (it is not one of these five roots). Parses violations from the JSON
 * reporter output. See `scripts/guards/depcruise.test.ts` for the
 * fixture-driven proof that each rule in the config actually fires.
 */
export function runDepcruise(): GuardResult {
  const configPath = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
  const sourceTrees = ['app', 'admin', 'website', 'packages', 'db'];

  const result = spawnSync(
    'pnpm',
    ['exec', 'depcruise', ...sourceTrees, '--config', configPath, '--output-type', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: true },
  );

  const stdout = result.stdout ?? '';
  let parsed: DepcruiseCruiseResult | undefined;
  try {
    parsed = JSON.parse(stdout) as DepcruiseCruiseResult;
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    // The CLI didn't produce parseable JSON - surface stderr/status so the
    // failure is visible instead of silently reporting zero violations.
    if (result.status !== 0) {
      return {
        violations: [
          {
            file: 'depcruise',
            message:
              result.stderr?.trim() || `depcruise exited with status ${String(result.status)}`,
          },
        ],
      };
    }
    return { violations: [] };
  }

  const violations = (parsed.summary?.violations ?? []).map((violation) => ({
    file: violation.from,
    message: `${violation.rule.name}: forbidden dependency on "${violation.to}"`,
  }));

  return { violations };
}

interface EslintJsonMessage {
  line?: number;
  message: string;
}

interface EslintJsonResult {
  filePath: string;
  messages: EslintJsonMessage[];
}

/**
 * Shells out to ESLint (the shared `packages/config/eslint.config.js`) over
 * the guard's resolved files and filters the JSON-reporter output down to
 * messages carrying `messagePrefix` (each `no-restricted-syntax` entry in
 * the shared config is given a distinctive `wp/<name>` message prefix so
 * one core rule's violations can be disambiguated per guard - see
 * `packages/config/eslint.config.js`).
 */
export function runEslintGuard(messagePrefix: string, files: string[]): GuardResult {
  if (files.length === 0) {
    return { violations: [] };
  }

  const configPath = path.join(REPO_ROOT, 'packages', 'config', 'eslint.config.js');

  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--config', configPath, '--format', 'json', ...files],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: true },
  );

  const stdout = result.stdout ?? '';
  let parsed: EslintJsonResult[] | undefined;
  try {
    parsed = JSON.parse(stdout) as EslintJsonResult[];
  } catch {
    parsed = undefined;
  }

  const violations: GuardViolation[] = [];
  for (const fileResult of parsed ?? []) {
    for (const message of fileResult.messages) {
      if (!message.message.includes(messagePrefix)) {
        continue;
      }
      violations.push({
        file: path.relative(REPO_ROOT, fileResult.filePath).split(path.sep).join('/'),
        line: message.line,
        message: message.message,
      });
    }
  }

  return { violations };
}
