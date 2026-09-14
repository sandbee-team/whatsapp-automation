import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDriftArtifact,
  checkpointReport,
  verdictReport,
  formatCheckpoint,
  formatVerdict,
  type DriftMarkRow,
  type ReadDriftArtifactResult,
} from './drift-run.js';

/**
 * scripts/measure/drift-run-cli.ts (P26 Unit U3, step 3) - the `--checkpoint`
 * / `--verdict` / `--mark` CLI modes, split out of `drift-run.ts` to stay
 * under the 300-line cap (the established split idiom - see
 * `session-worker-discovery-wiring.ts`). These modes read/append files only;
 * they never start a fleet.
 */

function readArtifactFile(path: string): ReadDriftArtifactResult {
  return readDriftArtifact(readFileSync(path, 'utf8'));
}

/**
 * Exit codes: `0` for `no-drift` (or a successful `--checkpoint`/`--mark`),
 * `2` for `drift`, `3` for `insufficient-data`, `1` for a usage error.
 */
export function runDriftCli(argv: string[]): number {
  const checkpointIdx = argv.indexOf('--checkpoint');
  if (checkpointIdx !== -1) {
    const path = argv[checkpointIdx + 1];
    if (!path) throw new Error('--checkpoint requires a <jsonl> path');
    const { samples } = readArtifactFile(path);
    console.log(formatCheckpoint(checkpointReport(samples)));
    return 0;
  }

  const verdictIdx = argv.indexOf('--verdict');
  if (verdictIdx !== -1) {
    const path = argv[verdictIdx + 1];
    if (!path) throw new Error('--verdict requires a <jsonl> path');
    const { samples } = readArtifactFile(path);
    const report = verdictReport(samples);
    console.log(formatVerdict(report));
    if (report.kind === 'drift') return 2;
    if (report.kind === 'insufficient-data') return 3;
    return 0;
  }

  const markIdx = argv.indexOf('--mark');
  if (markIdx !== -1) {
    const path = argv[markIdx + 1];
    const note = argv[markIdx + 2];
    if (!path || note === undefined) throw new Error('--mark requires a <jsonl> path and a note');
    const mark: DriftMarkRow = { kind: 'mark', ts: Date.now(), note };
    appendFileSync(path, `${JSON.stringify(mark)}\n`, 'utf8');
    console.log(`mark appended: ${note}`);
    return 0;
  }

  console.error(
    'drift-run: no mode given - use --checkpoint <jsonl>, --verdict <jsonl>, or --mark <jsonl> "<note>"',
  );
  return 1;
}

// Cross-platform isMain idiom (same as pacing-run-verify.ts): fileURLToPath +
// resolve. A raw string compare against `file://${argv1}` never matches a Windows
// drive-letter URL (`file:///D:/...` vs `file://D:/...`), so this CLI silently
// printed nothing and exited 0 (found at the v1 release gate, 2026-09-09).
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  process.exitCode = runDriftCli(process.argv.slice(2));
}
