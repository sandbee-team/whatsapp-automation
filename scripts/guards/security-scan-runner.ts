import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, resolveFiles } from './scan-config.js';
import type { GuardResult } from './scan-config.js';
import {
  buildSecretScanArgv,
  buildSemgrepArgv,
  buildTrivyArgv,
  classifyScannerExit,
  parseFindingsSummary,
} from './security-scan-lib.js';
import type { ScannerArgv, ScannerName, SpawnLike } from './security-scan-lib.js';
import {
  SEMGREP_GUARD_GLOBS,
  TRIVY_GUARD_GLOBS,
  SECRET_SCAN_GUARD_GLOBS,
} from './security-scan-guards-globs.js';

export { SEMGREP_GUARD_GLOBS, TRIVY_GUARD_GLOBS, SECRET_SCAN_GUARD_GLOBS };

/**
 * security-scan-runner.ts (P29a launch-hardening Unit U1) - wires the pure
 * argv builders + classifier in `security-scan-lib.ts` to a real (or
 * injected fake) `spawnSync` and the real filesystem. Split out of
 * `security-scan-lib.ts` to keep that file a pure leaf module (same
 * discipline as `run-source-guards.ts`/`shell-out-guards.ts`).
 *
 * Every image is pinned by BOTH tag and digest - see
 * `docs/evidence/P29-security-scans.md` for how each pin was obtained
 * (`docker pull <image>:<tag>` then `docker image inspect`).
 */
export const SEMGREP_IMAGE =
  'semgrep/semgrep:1.99.0@sha256:ae27024c16f7848cdbfd49c24ed0b78b13f13b85fcd7b87c679aaa8b0c0dce98';
export const TRIVY_IMAGE =
  'aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7';
export const GITLEAKS_IMAGE =
  'zricethezav/gitleaks:v8.29.0@sha256:71d3ee5990f2176f763b438298453fc37e87b119122045e176ca9d44ff00b08b';

/**
 * `maxBuffer` is raised well past Node's 1 MB default - a full-tree semgrep
 * JSON findings report (or the streamed tar archive on stdin) can exceed
 * that easily even with zero findings, once stdout carries progress output.
 */
const MAX_SPAWN_BUFFER_BYTES = 64 * 1024 * 1024;

const realSpawn: SpawnLike = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, {
    ...opts,
    encoding: 'utf8',
    shell: false,
    maxBuffer: MAX_SPAWN_BUFFER_BYTES,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

/**
 * Semgrep is the only scanner with a non-default timeout: a hung `docker
 * run` (e.g. daemon wedged mid-extract) must classify as a `tool-error`
 * (`spawnSync` sets `result.error`/`status: null` on timeout), never hang
 * the gate indefinitely. Trivy/gitleaks keep Node's default (no timeout) -
 * both complete in single-digit seconds against the pinned images.
 */
const SEMGREP_TIMEOUT_MS = 20 * 60 * 1000;

export interface ScanOutcome {
  exitCode: number;
  summary: string;
  violations: { file: string; message: string }[];
}

/**
 * Runs one named scanner and returns its classified outcome. `scanRoot`
 * lets a test point the scan at a single fixture directory instead of the
 * real repo tree (see `security-scan.test.ts`'s
 * `each_scanner_fails_on_its_seeded_fixture`).
 */
export function runScanner(
  name: ScannerName,
  spawn: SpawnLike = realSpawn,
  repoRoot: string = REPO_ROOT,
  scanRoot: string = repoRoot,
): ScanOutcome {
  let outDir: string | undefined;
  let argv: ScannerArgv;

  if (name === 'semgrep') {
    argv = buildSemgrepArgv(repoRoot, SEMGREP_IMAGE, scanRoot);
  } else if (name === 'trivy') {
    argv = buildTrivyArgv(repoRoot, TRIVY_IMAGE, scanRoot);
  } else {
    outDir = mkdtempSync(path.join(tmpdir(), 'wp-gitleaks-'));
    argv = buildSecretScanArgv(repoRoot, GITLEAKS_IMAGE, outDir, scanRoot);
  }

  const result = spawn(argv.cmd, argv.args, {
    cwd: repoRoot,
    input: argv.input,
    ...(name === 'semgrep' ? { timeout: SEMGREP_TIMEOUT_MS } : {}),
  });
  const classification = classifyScannerExit(name, result);

  let stdoutForFindings = result.stdout;
  if (name === 'secret-scan' && outDir !== undefined) {
    try {
      stdoutForFindings = readFileSync(path.join(outDir, 'report.json'), 'utf8');
    } catch {
      stdoutForFindings = '';
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }

  const violations: { file: string; message: string }[] = [];
  let summary = classification.summary;

  if (classification.kind === 'findings') {
    const findings = parseFindingsSummary(name, stdoutForFindings);
    summary = `${classification.summary} ${String(findings.count)} finding(s).`;
    for (const line of findings.lines) {
      violations.push({ file: name, message: line });
    }
  } else if (classification.kind !== 'clean') {
    violations.push({ file: name, message: classification.summary });
  }

  return { exitCode: classification.exitCode, summary, violations };
}

function toGuardResult(outcome: ScanOutcome): GuardResult {
  return { violations: outcome.violations };
}

export function runSemgrepGuard(): GuardResult {
  resolveFiles(SEMGREP_GUARD_GLOBS); // proves the glob matches; scan itself covers the whole tree.
  return toGuardResult(runScanner('semgrep'));
}

export function runTrivyGuard(): GuardResult {
  resolveFiles(TRIVY_GUARD_GLOBS);
  return toGuardResult(runScanner('trivy'));
}

export function runSecretScanGuard(): GuardResult {
  resolveFiles(SECRET_SCAN_GUARD_GLOBS);
  return toGuardResult(runScanner('secret-scan'));
}
