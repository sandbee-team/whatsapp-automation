/**
 * security-scan-classify.ts (P29a launch-hardening Unit U1) - the raw
 * spawn-result classifier and per-scanner findings-summary parser, split out
 * of `security-scan-lib.ts` to stay under its `max-lines: 300` cap (same
 * discipline as `registry-adapters.ts`). Still a pure leaf module: no I/O.
 */

export type ScannerExitKind =
  'clean' | 'findings' | 'db-download-failed' | 'tool-missing' | 'tool-error';

export interface ScannerClassification {
  kind: ScannerExitKind;
  exitCode: number;
  summary: string;
}

const DB_DOWNLOAD_FAILURE_PATTERN =
  /failed to download|DB download|unable to download|no such host|dial tcp|TLS handshake timeout|context deadline exceeded/i;

/**
 * Classifies a scanner's raw spawn result. Nothing but `clean` may map to
 * exit code 0 - a DB-download failure, a missing tool, or an unparseable
 * error must all fail the build (never a silent pass).
 */
export function classifyScannerExit(
  name: string,
  result: { status: number | null; stdout: string; stderr: string; error?: Error },
): ScannerClassification {
  if (result.error !== undefined || result.status === null) {
    return {
      kind: 'tool-missing',
      exitCode: 2,
      summary: `BLOCKED: ${name} could not be run (${result.error?.message ?? 'no status code'}). Install Docker Desktop and ensure the pinned image can be pulled - see docs/evidence/P29-security-scans.md.`,
    };
  }

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (DB_DOWNLOAD_FAILURE_PATTERN.test(combinedOutput)) {
    return {
      kind: 'db-download-failed',
      exitCode: 3,
      summary: `${name}: vulnerability/rule database could not be downloaded - this is a build failure, never a silent pass.`,
    };
  }

  if (result.status === 0) {
    // Defense-in-depth: a status 0 whose stdout still parses as a
    // findings-shaped JSON blob with at least one finding must never be
    // classified `clean` - that would be a silent pass masking a scanner or
    // wrapper bug that swallowed the real (non-zero) exit code.
    const findingsDespiteZeroExit = parseFindingsSummary(name, result.stdout);
    if (findingsDespiteZeroExit.count > 0) {
      return {
        kind: 'tool-error',
        exitCode: 4,
        summary: `${name}: exited 0 but stdout contains ${String(findingsDespiteZeroExit.count)} finding(s) - refusing to report clean.`,
      };
    }
    return { kind: 'clean', exitCode: 0, summary: `${name}: clean, 0 findings.` };
  }

  if (result.status === 1) {
    // An exit-1 findings report with EMPTY stdout has nothing to parse -
    // that is a tool malfunction (crashed before writing its report), not a
    // legitimate findings report, and must not be classified `findings`.
    // `secret-scan` is exempt: gitleaks legitimately writes its report to a
    // file (`--report-path /out/report.json`, see `buildSecretScanArgv`),
    // never to stdout, so an empty `result.stdout` on exit 1 is its NORMAL
    // shape - `security-scan-runner.ts` re-reads the report file separately
    // before parsing findings for that scanner.
    if (name !== 'secret-scan' && result.stdout.trim() === '') {
      return {
        kind: 'tool-error',
        exitCode: 4,
        summary: `${name}: exited 1 with empty stdout - no findings report was produced.`,
      };
    }
    return {
      kind: 'findings',
      exitCode: 1,
      summary: `${name}: findings reported (exit 1) - see parsed summary.`,
    };
  }

  return {
    kind: 'tool-error',
    exitCode: 4,
    summary: `${name}: unexpected exit status ${String(result.status)} - ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
  };
}

export interface FindingsSummary {
  count: number;
  lines: string[];
}

const MAX_FINDING_LINES = 20;

interface SemgrepResult {
  path?: string;
  start?: { line?: number };
  check_id?: string;
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  Severity?: string;
}

interface TrivyResultEntry {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
}

interface GitleaksFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number;
}

/**
 * Parses each scanner's JSON findings shape into redacted "rule id +
 * file:line" summary lines - NEVER the matched text or secret itself.
 */
export function parseFindingsSummary(name: string, stdout: string): FindingsSummary {
  const lines: string[] = [];

  try {
    if (name === 'semgrep') {
      const parsed = JSON.parse(stdout) as { results?: SemgrepResult[] };
      for (const r of parsed.results ?? []) {
        lines.push(`${r.check_id ?? 'unknown-rule'}: ${r.path ?? 'unknown'}:${r.start?.line ?? 0}`);
      }
    } else if (name === 'trivy') {
      const parsed = JSON.parse(stdout) as { Results?: TrivyResultEntry[] };
      for (const result of parsed.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
          lines.push(
            `${vuln.VulnerabilityID ?? 'unknown-cve'} (${vuln.Severity ?? 'unknown'}): ${result.Target ?? 'unknown'}`,
          );
        }
      }
    } else if (name === 'secret-scan') {
      const parsed = JSON.parse(stdout) as GitleaksFinding[];
      for (const finding of parsed) {
        lines.push(
          `${finding.RuleID ?? 'unknown-rule'}: ${finding.File ?? 'unknown'}:${finding.StartLine ?? 0}`,
        );
      }
    }
  } catch {
    return { count: 0, lines: [] };
  }

  return { count: lines.length, lines: lines.slice(0, MAX_FINDING_LINES) };
}
