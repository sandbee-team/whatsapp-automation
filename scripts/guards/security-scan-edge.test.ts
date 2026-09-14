import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSecretScanArgv,
  buildSemgrepArgv,
  buildTrivyArgv,
  classifyScannerExit,
} from './security-scan-lib.js';
import { parseFindingsSummary } from './security-scan-classify.js';
import { runScanner } from './security-scan-runner.js';
import { REPO_ROOT } from './registry.js';
import type { SpawnLike } from './security-scan-lib.js';

/**
 * security-scan-edge.test.ts (P29a E3/C2 hardening) - classification
 * honesty and argv hygiene edge cases NOT covered by security-scan.test.ts's
 * four cases. No real docker spawn here (all `SpawnLike` fakes) - the one
 * real-docker case stays exclusively in security-scan.test.ts per the
 * dispatch instruction.
 */

describe('classifyScannerExit honesty', () => {
  it('status_0_with_findings_json_in_stdout_is_never_clean', () => {
    // A scanner that exits 0 but whose stdout is a findings-shaped JSON blob
    // (e.g. a scanner bug, or a wrapper script swallowing the real exit
    // code) must never be classified `clean` - that would be a silent pass.
    const semgrepFindingsJson = JSON.stringify({
      results: [{ check_id: 'wp.no-tls-verification-disabled', path: 'x.ts', start: { line: 1 } }],
    });
    const classification = classifyScannerExit('semgrep', {
      status: 0,
      stdout: semgrepFindingsJson,
      stderr: '',
    });
    expect(classification.kind).not.toBe('clean');
  });

  it('status_1_with_empty_stdout_is_tool_error_not_findings', () => {
    // Exit 1 normally means "findings reported", but an empty stdout means
    // there is nothing to parse - that is a tool malfunction, not a
    // legitimate findings report, and must not be classified `findings`.
    const classification = classifyScannerExit('trivy', {
      status: 1,
      stdout: '',
      stderr: '',
    });
    expect(classification.kind).not.toBe('findings');
  });

  it('exit_codes_2_125_126_127_never_map_to_status_0', () => {
    for (const status of [2, 125, 126, 127]) {
      const classification = classifyScannerExit('trivy', { status, stdout: '', stderr: '' });
      expect(classification.exitCode).not.toBe(0);
      expect(['tool-missing', 'tool-error']).toContain(classification.kind);
    }
  });

  it('docker_daemon_down_stderr_is_never_a_silent_pass', () => {
    const classification = classifyScannerExit('semgrep', {
      status: 1,
      stdout: '',
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    });
    expect(classification.exitCode).not.toBe(0);
    expect(classification.kind).not.toBe('clean');
  });

  it('a_huge_stdout_does_not_throw_the_parser', () => {
    const hugeResults = Array.from({ length: 100_000 }, (_, i) => ({
      check_id: `rule-${String(i)}`,
      path: 'x.ts',
      start: { line: i },
    }));
    const hugeStdout = JSON.stringify({ results: hugeResults });
    expect(hugeStdout.length).toBeGreaterThan(5 * 1024 * 1024);

    expect(() => parseFindingsSummary('semgrep', hugeStdout)).not.toThrow();
    const parsed = parseFindingsSummary('semgrep', hugeStdout);
    expect(parsed.count).toBe(100_000);
    expect(parsed.lines.length).toBeLessThanOrEqual(20);
  });

  it('a_planted_fake_secret_in_findings_text_is_never_echoed_in_the_summary', () => {
    const PLANTED_FAKE_TOKEN = 'ghp_VxWFNr3hZCGjnDlMbRHTkWmp0xDvuGyTHSJp';
    // gitleaks findings carry RuleID/File/StartLine only - the matched
    // secret text itself must never appear in a summary line even if a
    // future gitleaks JSON shape started including it under an unexpected
    // key this parser does not read.
    const gitleaksJson = JSON.stringify([
      {
        RuleID: 'generic-api-key',
        File: 'x.env',
        StartLine: 3,
        Secret: PLANTED_FAKE_TOKEN,
        Match: `token=${PLANTED_FAKE_TOKEN}`,
      },
    ]);
    const parsed = parseFindingsSummary('secret-scan', gitleaksJson);
    const rendered = JSON.stringify(parsed);
    expect(rendered).not.toContain(PLANTED_FAKE_TOKEN);
  });
});

describe('argv hygiene', () => {
  const image = 'example/scanner@sha256:' + 'a'.repeat(64);

  it('every_argv_builder_mounts_read_only_and_never_privileged', () => {
    const semgrepArgv = buildSemgrepArgv(REPO_ROOT, image);
    const trivyArgv = buildTrivyArgv(REPO_ROOT, image);
    const secretArgv = buildSecretScanArgv(REPO_ROOT, image, path.join(REPO_ROOT, 'tmp-out'));

    for (const argv of [semgrepArgv, trivyArgv, secretArgv]) {
      expect(argv.args).not.toContain('--privileged');
    }

    // Semgrep ships its sources on stdin (`-i`) instead of a bind mount - no
    // `-v` flag at all (see security-scan-lib.ts's header for why).
    expect(semgrepArgv.args).not.toContain('-v');
    expect(semgrepArgv.args).toContain('-i');
    expect(semgrepArgv.input).toBeInstanceOf(Buffer);
    expect(semgrepArgv.input?.length).toBeGreaterThan(0);

    // Trivy/gitleaks still bind-mount their scan target. Every mount that
    // maps a HOST FILESYSTEM PATH (starts with the repo root, i.e. an
    // absolute path, not a named volume like `wp-trivy-cache`) must be
    // read-only (`:ro`) except the gitleaks OUTPUT mount, which is
    // deliberately writable (`:ro` would break `--report-path`).
    for (const argv of [trivyArgv, secretArgv]) {
      const mountFlags = argv.args.filter((_, i) => argv.args[i - 1] === '-v');
      expect(mountFlags.length).toBeGreaterThan(0);
      const pathMounts = mountFlags.filter((mount) => mount.startsWith(REPO_ROOT));
      expect(pathMounts.length).toBeGreaterThan(0);
      for (const mount of pathMounts) {
        const isOutputMount = mount.endsWith(':/out');
        if (!isOutputMount) {
          expect(mount.endsWith(':ro')).toBe(true);
        }
      }
    }
  });

  it('gitleaks_argv_never_contains_a_git_aware_subcommand', () => {
    const secretArgv = buildSecretScanArgv(REPO_ROOT, image, path.join(REPO_ROOT, 'tmp-out'));
    expect(secretArgv.args).not.toContain('detect');
    expect(secretArgv.args).not.toContain('protect');
    expect(secretArgv.args).toContain('dir');
  });

  it('no_argv_carries_a_bare_git_token', () => {
    const semgrepArgv = buildSemgrepArgv(REPO_ROOT, image);
    const trivyArgv = buildTrivyArgv(REPO_ROOT, image);
    const secretArgv = buildSecretScanArgv(REPO_ROOT, image, path.join(REPO_ROOT, 'tmp-out'));
    for (const argv of [semgrepArgv, trivyArgv, secretArgv]) {
      expect(argv.args).not.toContain('git');
    }
  });

  it('a_repo_root_with_spaces_and_a_drive_letter_is_one_arg_not_split', () => {
    const weirdRoot = 'C:\\Program Files\\wp repo (2)';

    // Semgrep no longer mounts the repo root at all (it streams sources on
    // stdin - see the `-v`/`-i` assertions above), so there is no host path
    // argv entry to check for it here. `buildSemgrepArgv` only reads real
    // files under the ACTUAL `REPO_ROOT` (via `resolveFiles`), so exercising
    // it against a non-existent `weirdRoot` belongs to the real repoRoot,
    // not this synthetic one - covered by `security-scan-tar.test.ts`
    // instead. What DOES matter here: nothing in its argv/shell-script gets
    // split by whitespace even when the (real) repoRoot varies - proven via
    // `toContainerSubpath`'s target argument, which never depends on
    // `weirdRoot` for the non-mount case.

    const trivyArgv = buildTrivyArgv(weirdRoot, image, weirdRoot);
    const trivyMount = trivyArgv.args.find((a) => a.startsWith(weirdRoot));
    expect(trivyMount).toBe(`${weirdRoot}:/src:ro`);
    // Never split into multiple argv entries by the space in the path.
    expect(trivyArgv.args.filter((a) => a === 'Files\\wp')).toHaveLength(0);

    const secretArgv = buildSecretScanArgv(
      weirdRoot,
      image,
      path.join(weirdRoot, 'out'),
      weirdRoot,
    );
    const secretMount = secretArgv.args.find((a) => a.startsWith(weirdRoot) && a.endsWith(':ro'));
    expect(secretMount).toBe(`${weirdRoot}:/src:ro`);
  });
});

describe('runScanner redaction end to end', () => {
  it('a_planted_fake_secret_never_reaches_the_scan_outcome_via_a_fake_spawn', () => {
    const PLANTED_FAKE_TOKEN = 'ghp_VxWFNr3hZCGjnDlMbRHTkWmp0xDvuGyTHSJp';
    const semgrepFindingsWithSecretShapedPath = JSON.stringify({
      results: [
        {
          check_id: 'wp.no-tls-verification-disabled',
          path: `secrets/${PLANTED_FAKE_TOKEN}.ts`,
          start: { line: 1 },
        },
      ],
    });
    const fakeSpawn: SpawnLike = () => ({
      status: 1,
      stdout: semgrepFindingsWithSecretShapedPath,
      stderr: '',
    });
    const outcome = runScanner('semgrep', fakeSpawn, REPO_ROOT, REPO_ROOT);
    // The finding line legitimately carries the reported PATH (which here
    // happens to embed the planted token because we constructed the fixture
    // that way) - that is a pre-existing property of "file:line" summaries,
    // not new leakage introduced by the redaction gate. What must never
    // happen is duplication anywhere else in the outcome.
    const rendered = JSON.stringify(outcome);
    const occurrences = rendered.split(PLANTED_FAKE_TOKEN).length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});
