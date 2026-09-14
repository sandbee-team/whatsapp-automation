import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProblems, type PacingRunArtifact } from './pacing-run-artifact.js';

/**
 * scripts/measure/pacing-run-verify.ts (P26 U5, step 5) - max-lines split
 * off `pacing-run-artifact.ts` (same idiom as
 * `session-worker-discovery-wiring.ts`): the artifact VALIDATOR, its
 * human-readable summary formatter, and the `--verify <json>` CLI entry
 * point. `validatePacingRunArtifact` re-derives its rules via
 * `collectProblems`, imported from the sibling, so the build-time verdict
 * (`buildPacingRunArtifact`) and this file's after-the-fact re-check can
 * never diverge.
 */

export interface ValidatePacingRunArtifactResult {
  ok: boolean;
  problems: string[];
}

function isPacingRunArtifactShape(value: unknown): value is PacingRunArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === 1 &&
    v.kind === 'pacing-run' &&
    typeof v.run === 'object' &&
    typeof v.connection === 'object' &&
    typeof v.reserveLatency === 'object' &&
    Array.isArray(v.capViolations) &&
    typeof v.jobs === 'object'
  );
}

/**
 * Re-derives `collectProblems` against an arbitrary parsed JSON value and
 * compares it to the artifact's OWN `verdict`/`problems` - `ok: false` (with
 * a named problem) if the shape does not even match `PacingRunArtifact`, if
 * any rule fires, or if a `verdict: 'PASS'` coexists with any problem
 * (either freshly-derived or self-reported) - a PASS alongside a problem is
 * itself always a named problem, never silently accepted.
 */
export function validatePacingRunArtifact(input: unknown): ValidatePacingRunArtifactResult {
  if (!isPacingRunArtifactShape(input)) {
    return { ok: false, problems: ['input does not match the PacingRunArtifact schema'] };
  }

  const derived = collectProblems(input);
  const problems = [...derived];

  if (input.verdict === 'PASS' && derived.length > 0) {
    problems.push('artifact reports verdict PASS alongside one or more problems');
  }
  if (input.verdict === 'FAIL' && derived.length === 0 && input.problems.length === 0) {
    problems.push('artifact reports verdict FAIL but no problems were found or recorded');
  }

  return { ok: problems.length === 0, problems };
}

/** Human-readable one-screen summary of a `PacingRunArtifact` - printed by run-pacing.ts and the `--verify` CLI. */
export function formatPacingRunSummary(a: PacingRunArtifact): string {
  const lines: string[] = [];
  lines.push(`pacing-run [${a.verdict}] captured ${a.capturedAtIso}`);
  const standUp =
    a.run.standUpSeconds === undefined
      ? ''
      : ` (drive window; fleet stand-up ${String(a.run.standUpSeconds)}s)`;
  lines.push(
    `  run: ${String(a.run.instances)} instances / ${String(a.run.workers)} workers / ${String(a.run.tenants)} tenants, ` +
      `planned ${String(a.run.plannedSeconds)}s, measured ${String(a.run.measuredSeconds)}s${standUp}`,
  );
  lines.push(`  connection: ${a.connection.label} (poolMode=${String(a.connection.poolMode)})`);
  lines.push(
    `  reserve() latency: samples=${String(a.reserveLatency.samples)} p50=${String(a.reserveLatency.p50Ms)}ms ` +
      `p95=${String(a.reserveLatency.p95Ms)}ms p99=${String(a.reserveLatency.p99Ms)}ms max=${String(a.reserveLatency.maxMs)}ms ` +
      `(SLO ${String(a.reserveLatency.sloMs)}ms)`,
  );
  lines.push(`  cap violations: ${String(a.capViolations.length)}`);
  lines.push(
    `  jobs: enqueued=${String(a.jobs.enqueued)} sent=${String(a.jobs.sent)} queued=${String(a.jobs.stillQueued)} ` +
      `failed=${String(a.jobs.terminalFailed)} blocked=${String(a.jobs.blockedNeedsReview)} cancelled=${String(a.jobs.cancelled)} ` +
      `duplicateAckedAttempts=${String(a.jobs.duplicateAckedAttempts)}`,
  );
  if (a.burst) {
    // An unmeasured window prints "NOT MEASURED (n samples)", never "0ms",
    // and a non-computable ratio prints as such, never "Infinity".
    const window = (p99Ms: number | null, samples: number): string =>
      `${p99Ms === null ? 'NOT MEASURED' : `${String(p99Ms)}ms`} (${String(samples)} samples)`;
    const ratio =
      a.burst.fairness.ratio === null ? 'not computable' : a.burst.fairness.ratio.toFixed(4);
    lines.push(
      `  burst: ${String(a.burst.recipients)} recipients at ${String(a.burst.startedAtMs)}ms (run-relative) - ` +
        `other-tenant claim p99 before=${window(a.burst.otherTenantsClaimP99BeforeMs, a.burst.samplesBefore)} ` +
        `during=${window(a.burst.otherTenantsClaimP99DuringMs, a.burst.samplesDuring)} ` +
        `fairness=${a.burst.fairness.ok ? 'OK' : 'FAIL'} (ratio ${ratio})`,
    );
  } else {
    lines.push('  burst: none');
  }
  lines.push(`  orphan reservations: NOT MEASURABLE - ${a.orphanReservations.reason}`);
  if (a.notes.length > 0) {
    lines.push('  notes:');
    for (const note of a.notes) lines.push(`    - ${note}`);
  }
  if (a.problems.length > 0) {
    lines.push('  problems:');
    for (const problem of a.problems) lines.push(`    - ${problem}`);
  }
  return lines.join('\n');
}

/** Prints each SLO/invariant with its measured value and PASS/FAIL, and returns the process exit code (0 pass, 1 fail) - never calls `process.exit` itself so it stays testable. */
export function runVerifyCli(
  jsonPath: string,
  readFile: (p: string) => string = readFileSync as (p: string) => string,
): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(jsonPath));
  } catch (err) {
    console.error(`pacing-run --verify: failed to read/parse ${jsonPath}: ${String(err)}`);
    return 1;
  }

  const result = validatePacingRunArtifact(parsed);
  if (isPacingRunArtifactShape(parsed)) {
    console.log(formatPacingRunSummary(parsed));
  }
  console.log(`\n--verify ${jsonPath}: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const problem of result.problems) {
    console.log(`  FAIL: ${problem}`);
  }
  return result.ok ? 0 : 1;
}

// Same cross-platform isMain idiom as run-drift.ts/send-load-driver-run.ts
// (fileURLToPath + resolve comparison - a raw string compare against
// `file://${argv1}` breaks on Windows drive-letter URLs).
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain && process.argv.includes('--verify')) {
  const idx = process.argv.indexOf('--verify');
  const jsonPath = process.argv[idx + 1];
  if (!jsonPath) {
    console.error('pacing-run --verify: missing <json> path argument');
    process.exitCode = 1;
  } else {
    process.exitCode = runVerifyCli(jsonPath);
  }
}
