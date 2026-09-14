import { readFileSync } from 'node:fs';
import type { PgLoadArtifact } from './pg-load.js';

/**
 * scripts/measure/pg-load-validate.ts (P26 C1 fix round, FIX-C MAJOR 5) -
 * `validatePgLoadArtifact`, `formatPgLoadSummary` and the `--verify` CLI,
 * split out of `pg-load.ts` for the 300-line cap (established idiom -
 * `session-worker-discovery-wiring.ts`). Pure code-motion: no behaviour
 * lives here that wasn't already owned by `pg-load.ts`'s own doc comment.
 */

/** Validates an already-built artifact (or any unknown JSON parsed off disk via `--verify`). Never throws - returns `{ ok, problems }`. */
export function validatePgLoadArtifact(input: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, problems: ['artifact is not an object'] };
  }
  const a = input as Partial<PgLoadArtifact>;

  if (!a.sends || a.sends.observed === undefined || a.sends.observed <= 0) {
    problems.push('sends.observed must be > 0 - a measurement needs at least one observed send');
  }
  if (!a.window || !Number.isFinite(a.window.seconds) || a.window.seconds <= 0) {
    problems.push('window.seconds must be a finite number > 0');
  }
  if (a.measured) {
    for (const [key, value] of Object.entries(a.measured)) {
      if (key === 'sampleSize') continue;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        problems.push(`measured.${key} is not finite`);
      }
    }
  }
  if (a.deltas?.statements === 0) {
    problems.push(
      'statements delta is 0 - pg_stat_statements was not tracking this window (not a valid 0 statements/send result)',
    );
  }
  if (a.viaPgBouncer === false) {
    const hasNote = (a.notes ?? []).some((n) => n.includes('DIRECT-CONNECTION'));
    if (!hasNote) {
      problems.push('viaPgBouncer is false with no DIRECT-CONNECTION note explaining why');
    }
  }
  if (a.derivedComparison && a.derivedComparison.agreement.trim() === '') {
    problems.push('derivedComparison.agreement must not be empty');
  }
  if (a.deltas && a.deltas.relationSizeBytes < 0) {
    problems.push(
      `relationSizeBytes total is negative (${String(a.deltas.relationSizeBytes)}) - net shrink over the window, named here rather than fabricated positive`,
    );
  }
  if (a.baseline === null || a.baseline === undefined) {
    const hasSkipNote = (a.notes ?? []).some(
      (n) => n.includes('--baseline-seconds 0') || n.includes('no idle baseline'),
    );
    if (!hasSkipNote) {
      problems.push(
        'baseline is missing with no note explaining why (pass --baseline-seconds 0 explicitly and note it, or sample a baseline)',
      );
    }
  }
  if (typeof a.jobStatusHistogram !== 'object' || a.jobStatusHistogram === null) {
    problems.push(
      'jobStatusHistogram is missing - a reader cannot see processing/needs_reconcile residue without it',
    );
  }
  if (a.drain) {
    if (a.drain.complete === false) {
      problems.push(
        `drain incomplete: ${String(a.drain.pendingAtEnd)} jobs still pending at the deadline - this artifact is evidence of a failed run, not a publishable load model`,
      );
    } else if (a.drain.complete === true && a.drain.pendingAtEnd > 0) {
      problems.push(
        `drain.complete is true but pendingAtEnd is ${String(a.drain.pendingAtEnd)} (must be 0) - contradiction`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

export function formatPgLoadSummary(a: PgLoadArtifact): string {
  const lines = [
    `pg-load measurement (${a.capturedAtIso}), via ${a.viaPgBouncer ? 'PgBouncer' : 'DIRECT CONNECTION'}`,
    `  window: ${a.window.seconds.toFixed(1)}s, sends observed=${String(a.sends.observed)} attempted=${String(a.sends.attempted)}`,
    `  measured: ${a.measured.statementsPerSend.toFixed(3)} statements/send, ${a.measured.bytesPerSend.toFixed(1)} bytes/send, ${a.measured.walMbPerSec.toFixed(3)} MB/s WAL, ${a.measured.sendsPerSecond.toFixed(2)} sends/sec`,
    `  vs ADR 0018 section 7 derived: ${a.derivedComparison.agreement}`,
  ];
  for (const p of a.projected) {
    lines.push(
      `  projected @ ${String(p.connected)} connected, ${String(p.sendsPerDayPerInstance)} sends/day/instance: ${p.gbPerDay.toFixed(2)} GB/day`,
    );
  }
  if (a.notes.length > 0) {
    lines.push('  notes:');
    for (const n of a.notes) lines.push(`    - ${n}`);
  }
  return lines.join('\n');
}

function runVerifyCli(argv: string[]): number {
  const idx = argv.indexOf('--verify');
  if (idx === -1) {
    console.error('pg-load: no mode given - use --verify <artifact.json>');
    return 1;
  }
  const path = argv[idx + 1];
  if (!path) {
    throw new Error('--verify requires a <artifact.json> path');
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const { ok, problems } = validatePgLoadArtifact(parsed);
  if (ok) {
    console.log(`pg-load --verify: OK (${path})`);
    return 0;
  }
  console.error(`pg-load --verify: FAILED (${path})`);
  for (const p of problems) console.error(`  - ${p}`);
  return 2;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (isMain) {
  process.exitCode = runVerifyCli(process.argv.slice(2));
}
