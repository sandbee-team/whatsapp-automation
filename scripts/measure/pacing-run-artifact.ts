import type { HardwareFingerprint } from './artifact.js';
import type { CapViolation } from './pacing-run.js';

/**
 * scripts/measure/pacing-run-artifact.ts (P26 U5, step 5) - max-lines split
 * off `pacing-run.ts` (same idiom as `session-worker-discovery-wiring.ts`):
 * the `PacingRunArtifact` schema, `collectProblems` (the VERDICT AUTHORITY -
 * the ONE place every SLO/invariant rule for the pacing run is written
 * down), and `buildPacingRunArtifact`. `pacing-run-verify.ts#
 * validatePacingRunArtifact` imports `collectProblems` from here to
 * re-derive the SAME rules against an already-written JSON file, so a
 * committed artifact's self-reported verdict and a fresh `--verify` run can
 * never silently diverge.
 */

export interface PacingRunSummaryOfRun {
  plannedSeconds: number;
  /** The DRIVE window only: first enqueue to drain-complete. Never includes fleet stand-up. */
  measuredSeconds: number;
  /** Fleet stand-up (spawn + seed + assign) in seconds, reported separately - a 1,000-instance stand-up is minutes and must never be read as run time. */
  standUpSeconds?: number;
  instances: number;
  workers: number;
  tenants: number;
}
export interface PacingRunConnection {
  viaPgBouncer: boolean;
  poolMode: string | null;
  label: 'THROUGH-PGBOUNCER' | 'DIRECT-CONNECTION';
}
export interface PacingReserveLatency {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  sloMs: 25;
}
export interface PacingRunJobs {
  /** Row-based bucket sum (invariant 7) - `sent+stillQueued+terminalFailed+blockedNeedsReview+cancelled`. Reported for humans; NEVER the conservation check's own baseline (see `driverEnqueued`). */
  enqueued: number;
  /** The load DRIVER's own count (`runSendLoad`'s `result.enqueued + result.burstEnqueued`) - the conservation check's baseline. Comparing rows against `enqueued` (also rows) is a tautology (CRITICAL 2(c)); this is the independent source of truth. */
  driverEnqueued: number;
  /** Row count of `pacing_ledger` examined for cap violations - `0` means the cap scan ran over nothing, which is never itself "zero violations" (CRITICAL 2(b)/MAJOR 3). */
  ledgerRowCount: number;
  sent: number;
  stillQueued: number;
  terminalFailed: number;
  blockedNeedsReview: number;
  cancelled: number;
  /**
   * FIX-P26-H MAJOR B (2026-09-07): count of `message_job_id`s with MORE
   * THAN ONE `send_attempts` row in `state = 'acked'` (see
   * `run-pacing-collect.ts#collectDuplicateAckedAttemptCount`). Duplicate
   * PROVIDER ids per job are already prevented at the storage layer by
   * `message_wa_ids_message_id_uq UNIQUE (client_id, instance_id,
   * message_id)` (migration 0026) - a second `message_wa_ids` row for the
   * same message_id cannot be inserted at all, so it was never a usable
   * duplicate-send signal. What this field actually measures is acked
   * attempts per job: a job accumulating more than one acked attempt is the
   * real symptom of a double-dispatch.
   */
  duplicateAckedAttempts: number;
}
export interface PacingRunBurst {
  recipients: number;
  /** RUN-RELATIVE offset (ms from run start) at which the burst ACTUALLY fired - the same instant the claim sampler bucketed against, never the mix file's default. */
  startedAtMs: number;
  /** `null` when the before window carried no samples - an unmeasured window is NEVER a fabricated 0. */
  otherTenantsClaimP99BeforeMs: number | null;
  /** `null` when the during window carried no samples - an unmeasured window is NEVER a fabricated 0. */
  otherTenantsClaimP99DuringMs: number | null;
  samplesBefore: number;
  samplesDuring: number;
  /** `ratio: null` means the comparison was not computable (an empty baseline), never "infinitely unfair". */
  fairness: { ok: boolean; ratio: number | null };
}

export interface PacingRunArtifact {
  schemaVersion: 1;
  kind: 'pacing-run';
  capturedAtIso: string;
  hardware: HardwareFingerprint;
  node: string;
  run: PacingRunSummaryOfRun;
  connection: PacingRunConnection;
  reserveLatency: PacingReserveLatency;
  capViolations: CapViolation[];
  jobs: PacingRunJobs;
  burst: PacingRunBurst | null;
  /** v1 has no `wp_pacing_orphan_reservations_total` detector (P25, RUNBOOK.md#deferred-alerts) - always `measurable: false`, never a fabricated zero. */
  orphanReservations: { measurable: false; reason: string };
  verdict: 'PASS' | 'FAIL';
  problems: string[];
  notes: string[];
}

const RESERVE_SLO_MS = 25;

/** Every named PASS/FAIL rule, in one place - shared by `buildPacingRunArtifact` and `pacing-run-verify.ts#validatePacingRunArtifact` so the two can never diverge. Exported for that reuse only. */
export function collectProblems(
  a: Omit<PacingRunArtifact, 'verdict' | 'problems' | 'notes'>,
): string[] {
  const problems: string[] = [];

  if (a.capViolations.length > 0) {
    problems.push(`${String(a.capViolations.length)} cap violation(s) found (see capViolations)`);
  }
  if (a.reserveLatency.samples === 0) {
    problems.push('reserveLatency.samples is 0 - reserve() latency was never measured');
  } else if (a.reserveLatency.p99Ms >= RESERVE_SLO_MS) {
    problems.push(
      `reserveLatency.p99Ms (${String(a.reserveLatency.p99Ms)}) >= SLO ${String(RESERVE_SLO_MS)}ms`,
    );
  }

  // Conservation compares the DRIVER's own count (an independent source)
  // against the row-based bucket sum - comparing rows against a row-derived
  // `enqueued` is a tautology that a vacuous zero-claim run still satisfies
  // (CRITICAL 2(c)).
  const jobSum =
    a.jobs.sent +
    a.jobs.stillQueued +
    a.jobs.terminalFailed +
    a.jobs.blockedNeedsReview +
    a.jobs.cancelled;
  if (a.jobs.driverEnqueued !== jobSum) {
    problems.push(
      `job conservation broken: driverEnqueued (${String(a.jobs.driverEnqueued)}) != sent+stillQueued+terminalFailed+blockedNeedsReview+cancelled (${String(jobSum)})`,
    );
  }
  if (a.jobs.duplicateAckedAttempts > 0) {
    problems.push(`duplicateAckedAttempts is ${String(a.jobs.duplicateAckedAttempts)} (must be 0)`);
  }
  // Vacuous-PASS detection (CRITICAL 2 / MAJOR 3): a run in which nothing was
  // ever claimed, or whose cap scan ran over zero ledger rows, must never
  // read as a clean pass just because every row-based identity holds
  // trivially over an empty set.
  if (a.jobs.sent === 0) {
    problems.push('jobs.sent is 0 - nothing was ever claimed');
  }
  if (a.jobs.ledgerRowCount === 0) {
    problems.push('pacing_ledger has 0 rows for the fleet');
  }

  if (a.burst) {
    // An EMPTY fairness window is its own named problem: it says the run
    // never measured fairness, which is a different fact from "fairness was
    // measured and was unfair". Reporting it as a 0 p99 / Infinity ratio is
    // what hid the mis-bucketed sampler in the P26 smoke.
    if (a.burst.samplesBefore === 0 || a.burst.otherTenantsClaimP99BeforeMs === null) {
      problems.push('no claim samples in the before window');
    }
    if (a.burst.samplesDuring === 0 || a.burst.otherTenantsClaimP99DuringMs === null) {
      problems.push('no claim samples in the during window');
    }
    if (!a.burst.fairness.ok && a.burst.fairness.ratio !== null) {
      problems.push(
        `burst fairness failed: ratio ${a.burst.fairness.ratio.toFixed(4)} exceeds tolerance`,
      );
    }
  }

  if (a.run.measuredSeconds <= 0) {
    problems.push(`run.measuredSeconds (${String(a.run.measuredSeconds)}) must be > 0`);
  }

  return problems;
}

/** Builds a `PacingRunArtifact`, deriving `verdict`/`problems` via `collectProblems` and appending a `DIRECT-CONNECTION` note when unpooled (never a failure alone, always surfaced). */
export function buildPacingRunArtifact(
  input: Omit<PacingRunArtifact, 'verdict' | 'problems' | 'notes'> & { notes?: string[] },
): PacingRunArtifact {
  const notes = [...(input.notes ?? [])];
  if (input.connection.label === 'DIRECT-CONNECTION') {
    notes.push(
      'reserve() latency was measured over a DIRECT Postgres connection, not through PgBouncer - PgBouncer was unreachable at run time.',
    );
  }

  const problems = collectProblems(input);
  const verdict: 'PASS' | 'FAIL' = problems.length === 0 ? 'PASS' : 'FAIL';

  return { ...input, notes, verdict, problems };
}
