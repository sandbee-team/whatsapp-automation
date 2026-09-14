import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { checkAlertRules, type AlertRulesInput } from './guards/alert-rules-clauses.js';
import { parseRuleFiles } from './guards/alert-rules-lib.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import { REPO_ROOT } from './guards/scan-config.js';

/**
 * check-alert-rules.ts (P25 Unit U4, step 7) - the alert-rules guard.
 * Combines the pure clauses (a)-(f) in guards/alert-rules-clauses.ts with a
 * shell part that runs `promtool check rules` on every rule file and
 * `promtool test rules` on the promtool unit test file - a rule set can
 * pass every pure clause here and still be malformed PromQL, so both halves
 * are required for a green guard.
 */

const ALERT_RULES_GLOBS = ['infra/observability/prometheus/rules/*.rules.yml'];
const TEST_FILE_RELATIVE = 'infra/observability/prometheus/rules/wp-alerts.test.yml';
const MANIFEST_RELATIVE = 'infra/observability/metrics.generated.json';
const RUNBOOK_RELATIVE = 'docs/RUNBOOK.md';
const RULES_DIR_RELATIVE = 'infra/observability/prometheus/rules';

interface PromtoolResult {
  ok: boolean;
  output: string;
}

/** Resolve and invoke promtool: env override -> PATH -> the pinned Prometheus Docker image. Never a silent skip. */
function resolvePromtoolRunner(): ((args: string[]) => PromtoolResult) | undefined {
  const envPath = process.env.WP_PROMTOOL;
  if (envPath) {
    return (args: string[]) => runSpawn(envPath, args);
  }

  const pathCheck = spawnSync('promtool', ['--version'], { encoding: 'utf8' });
  if (pathCheck.status === 0) {
    return (args: string[]) => runSpawn('promtool', args);
  }

  const dockerCheck = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (dockerCheck.status === 0) {
    return (args: string[]) => {
      const rulesDirAbs = path.resolve(REPO_ROOT, RULES_DIR_RELATIVE);
      const dockerArgs = [
        'run',
        '--rm',
        '--entrypoint',
        'promtool',
        '-v',
        `${rulesDirAbs}:/rules`,
        'prom/prometheus:v3.14.0',
        ...args,
      ];
      return runSpawn('docker', dockerArgs);
    };
  }

  return undefined;
}

function runSpawn(command: string, args: string[]): PromtoolResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output };
}

/** `rulesDir` is accepted for interface symmetry with the phase Dispatch plan's `runPromtool(rulesDir, args)` signature; the Docker fallback resolves its own bind mount from `RULES_DIR_RELATIVE` so every caller (PATH, env override, or Docker) shares one resolution path. */
export function runPromtool(rulesDir: string, args: string[]): PromtoolResult {
  void rulesDir;
  const runner = resolvePromtoolRunner();
  if (!runner) {
    return {
      ok: false,
      output: 'promtool unavailable (install promtool, set WP_PROMTOOL, or start Docker)',
    };
  }
  return runner(args);
}

function ruleFileNamesRelativeToRulesDir(absolutePaths: string[]): string[] {
  return absolutePaths.map((p) => path.basename(p));
}

export interface AlertRulesGuardResult extends GuardResult {
  alertCount: number;
  recordingRuleCount: number;
}

export function runCheckAlertRules(): AlertRulesGuardResult {
  const ruleFileAbsolutePaths = fg
    .sync(ALERT_RULES_GLOBS, { cwd: REPO_ROOT, onlyFiles: true })
    .map((relativePath) => path.join(REPO_ROOT, relativePath));

  const ruleFiles = ruleFileAbsolutePaths.map((absolutePath) => ({
    path: path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/'),
    content: readFileSync(absolutePath, 'utf8'),
  }));

  const testFileText = readFileSync(path.join(REPO_ROOT, TEST_FILE_RELATIVE), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, MANIFEST_RELATIVE), 'utf8')) as {
    metrics: { name: string; type: string }[];
  };
  const runbookText = readFileSync(path.join(REPO_ROOT, RUNBOOK_RELATIVE), 'utf8');

  const input: AlertRulesInput = {
    ruleFiles,
    testFileText,
    manifestNames: manifest.metrics,
    runbookText,
  };

  const violations: GuardViolation[] = [...checkAlertRules(input)];
  const { alerts, recordingRules } = parseRuleFiles(ruleFiles);

  if (ruleFiles.length === 0) {
    violations.push({
      file: 'infra/observability/prometheus/rules',
      message: 'no rule files found',
    });
  }
  if (alerts.length === 0) {
    violations.push({ file: 'infra/observability/prometheus/rules', message: 'no alerts parsed' });
  }

  const rulesDirAbs = path.resolve(REPO_ROOT, RULES_DIR_RELATIVE);
  const ruleFileArgs = ruleFileNamesRelativeToRulesDir(ruleFileAbsolutePaths).map(
    (name) => `/rules/${name}`,
  );
  const checkResult = runPromtool(rulesDirAbs, ['check', 'rules', ...ruleFileArgs]);
  if (!checkResult.ok) {
    violations.push({
      file: 'infra/observability/prometheus/rules',
      message: `promtool check rules failed: ${checkResult.output.trim()}`,
    });
  }

  const testResult = runPromtool(rulesDirAbs, ['test', 'rules', '/rules/wp-alerts.test.yml']);
  if (!testResult.ok) {
    violations.push({
      file: TEST_FILE_RELATIVE,
      message: `promtool test rules failed: ${testResult.output.trim()}`,
    });
  }

  return {
    violations,
    filesScanned: ruleFiles.length + 1,
    alertCount: alerts.length,
    recordingRuleCount: recordingRules.length,
  };
}

function main(): void {
  const result = runCheckAlertRules();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`check-alert-rules: ${violation.file} - ${violation.message}`);
    }
  }
  console.log(
    `check-alert-rules: ${String(result.filesScanned ?? 0)} rule files, ${String(result.alertCount)} alerts, ${String(result.recordingRuleCount)} recording rules, ${String(result.violations.length)} violation(s)`,
  );

  if (result.violations.length > 0) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
