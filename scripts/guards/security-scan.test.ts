import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_STEPS } from '../ci-steps.js';
import { GUARDS, REPO_ROOT, resolveFiles } from './registry.js';
import {
  buildSecretScanArgv,
  buildSemgrepArgv,
  buildTrivyArgv,
  classifyScannerExit,
} from './security-scan-lib.js';
import { GITLEAKS_IMAGE, SEMGREP_IMAGE, TRIVY_IMAGE, runScanner } from './security-scan-runner.js';
import type { SpawnLike } from './security-scan-lib.js';

/**
 * security-scan.test.ts (P29a launch-hardening Unit U1) - proves the three
 * pinned-Docker-image security scanners are registered as both CI steps and
 * guards, that each fires on a REAL seeded fixture via the actual Docker
 * image (never mocked - a mocked scanner proves nothing about the real
 * tool), that the secret scanner never runs in a git-aware mode (ADR 0003:
 * this repo must never become a git repository), and that a scanner whose
 * database cannot be downloaded fails the build rather than passing
 * silently.
 */

const FIXTURES_DIR = path.join(REPO_ROOT, 'scripts', 'guards', '__fixtures__', 'security');
const PLANTED_SECRET_DIR = path.join(FIXTURES_DIR, 'planted-secret');
const INSECURE_TLS_DIR = path.join(FIXTURES_DIR, 'insecure-tls');
const HIGH_CVE_DIR = path.join(FIXTURES_DIR, 'high-cve');
const PLANTED_FAKE_TOKEN = 'ghp_VxWFNr3hZCGjnDlMbRHTkWmp0xDvuGyTHSJp';

function dockerIsRunnable(): boolean {
  const result = spawnSync('docker', ['version'], { encoding: 'utf8', shell: false });
  return result.status === 0;
}

const realSpawn: SpawnLike = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, {
    ...opts,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

describe('security-scan (P29a launch-hardening Unit U1)', () => {
  it('semgrep_trivy_and_secret_scan_are_registered_ci_steps', () => {
    const alertRulesIndex = CI_STEPS.findIndex((step) => step.name === 'alert-rules');
    expect(alertRulesIndex).toBeGreaterThanOrEqual(0);
    expect(CI_STEPS[alertRulesIndex + 1]?.name).toBe('semgrep');
    expect(CI_STEPS[alertRulesIndex + 2]?.name).toBe('trivy');
    expect(CI_STEPS[alertRulesIndex + 3]?.name).toBe('secret-scan');

    const guardNames = GUARDS.map((guard) => guard.name);
    expect(guardNames).toContain('security:semgrep');
    expect(guardNames).toContain('security:trivy');
    expect(guardNames).toContain('security:secret-scan');

    for (const name of ['security:semgrep', 'security:trivy', 'security:secret-scan']) {
      const guard = GUARDS.find((g) => g.name === name);
      expect(guard, `guard "${name}" not found`).toBeDefined();
      const files = resolveFiles(guard?.globs ?? []);
      expect(files.length, `guard "${name}" matched 0 files`).toBeGreaterThan(0);
    }

    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['check:semgrep']).toBeDefined();
    expect(packageJson.scripts?.['check:trivy']).toBeDefined();
    expect(packageJson.scripts?.['check:secret-scan']).toBeDefined();
  });

  it('each_scanner_fails_on_its_seeded_fixture', () => {
    if (!dockerIsRunnable()) {
      throw new Error(
        'BLOCKED: docker is required to run the pinned scanner images; the scanners cannot be proven and this test must not pass',
      );
    }

    // semgrep: insecure-tls fixture, scanned directly (paths.include rules
    // are scoped to real production paths, so this exercises the
    // path-unscoped wp.no-tls-verification-disabled rule instead).
    {
      const argv = buildSemgrepArgv(REPO_ROOT, SEMGREP_IMAGE, INSECURE_TLS_DIR);
      const result = realSpawn(argv.cmd, argv.args, { cwd: REPO_ROOT, input: argv.input });
      const classification = classifyScannerExit('semgrep', result);
      expect(classification.kind).toBe('findings');
      expect(classification.exitCode).toBe(1);
    }

    // trivy: high-cve fixture (lodash 4.17.15, CVE-2020-8203, HIGH, fixed
    // in 4.17.19 - deterministic, no image pull needed).
    {
      const argv = buildTrivyArgv(REPO_ROOT, TRIVY_IMAGE, HIGH_CVE_DIR);
      const result = realSpawn(argv.cmd, argv.args, { cwd: REPO_ROOT });
      const classification = classifyScannerExit('trivy', result);
      expect(classification.kind).toBe('findings');
      expect(classification.exitCode).toBe(1);
      expect(result.stdout).toContain('CVE-2020-8203');
    }

    // secret scan: planted-secret fixture (fake GitHub PAT shape).
    {
      const outcome = runScanner('secret-scan', realSpawn, REPO_ROOT, PLANTED_SECRET_DIR);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.summary).toContain('finding');
      const rendered = JSON.stringify(outcome);
      expect(rendered).not.toContain(PLANTED_FAKE_TOKEN);
    }
  }, 600000);

  it('the_secret_scanner_runs_in_filesystem_mode_and_never_invokes_git', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeSpawn: SpawnLike = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };

    runScanner('secret-scan', fakeSpawn);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cmd).toBe('docker');
    expect(call?.args).toContain('dir');
    expect(call?.args).not.toContain('git');
    expect(call?.args).not.toContain('detect');
    expect(call?.args).not.toContain('protect');
    expect(call?.args).not.toContain('--log-opts');

    // Also prove the argv builders themselves never carry a standalone
    // "git" token, for every scanner - not just the secret scanner.
    const semgrepArgv = buildSemgrepArgv(REPO_ROOT, SEMGREP_IMAGE);
    const trivyArgv = buildTrivyArgv(REPO_ROOT, TRIVY_IMAGE);
    const secretArgv = buildSecretScanArgv(
      REPO_ROOT,
      GITLEAKS_IMAGE,
      path.join(REPO_ROOT, 'tmp-out'),
    );
    for (const argv of [semgrepArgv, trivyArgv, secretArgv]) {
      expect(argv.args).not.toContain('git');
    }
    expect(secretArgv.args).toContain('dir');
  });

  it('a_scanner_that_cannot_fetch_its_database_fails_the_build', () => {
    const dbDownloadFailure = classifyScannerExit('trivy', {
      status: 1,
      stdout: '',
      stderr:
        'FATAL init error: DB error: failed to download vulnerability DB: some transport error',
    });
    expect(dbDownloadFailure.kind).toBe('db-download-failed');
    expect(dbDownloadFailure.exitCode).toBe(3);

    const stillFailsEvenWithStatusZero = classifyScannerExit('trivy', {
      status: 0,
      stdout: '',
      stderr: 'failed to download vulnerability DB',
    });
    expect(stillFailsEvenWithStatusZero.kind).toBe('db-download-failed');
    expect(stillFailsEvenWithStatusZero.exitCode).not.toBe(0);

    const missingTool = classifyScannerExit('semgrep', {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawnSync docker ENOENT'),
    });
    expect(missingTool.kind).toBe('tool-missing');
    expect(missingTool.exitCode).toBe(2);
    expect(missingTool.summary.startsWith('BLOCKED:')).toBe(true);
  });
});
