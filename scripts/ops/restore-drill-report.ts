import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatRestoreDrillMarkdown,
  type FormattableRestoreDrillReport,
} from './restore-drill-report-markdown.js';

/**
 * scripts/ops/restore-drill-report.ts (P26 U7; P29a Unit U3 step 9 adds the
 * v2 fields below) - PURE report schema, validator (Node builtins only - no
 * `pg`/`@wp/db`). Shared by `scripts/__tests__` and `run-restore-verify.ts`
 * (one rule set, never two). INTERNAL evidence only (ADR 0016 - no figure
 * here is quotable); the markdown banner (formatter now in the sibling
 * `restore-drill-report-markdown.ts`, split for the `max-lines` cap) says
 * so.
 *
 * `schemaVersion: 2` is ADDITIVE over v1: every v1 report field still
 * exists unchanged; v2 adds `restore.mode`, `verification.parity`,
 * `verification.ledgerChain`, `recovery`, and `rto`. A v1 report (missing
 * those fields) still validates - `computeRestoreDrillProblems`'s new rules
 * are skipped when the corresponding field is absent, so `--validate` on an
 * old report never regresses.
 */

// Constants and the report shape live in the leaf module below (P29a C1 fix:
// breaks the report <-> markdown import cycle); re-exported here so every
// existing importer keeps working.
export { ADR_0018_TIER_CLAIM, INTERNAL_BANNER } from './restore-drill-report-types.js';
export type { RestoreDrillReport } from './restore-drill-report-types.js';
import type { RestoreDrillReport } from './restore-drill-report-types.js';

/**
 * Pure rule evaluation shared by `validateRestoreDrillReport` and by
 * `run-restore-verify.ts` when it computes its OWN `verdict` before writing
 * the report - the two must never diverge (a report that says PASS from a
 * different rule set than `--validate` uses is not evidence).
 */
export function computeRestoreDrillProblems(report: Partial<RestoreDrillReport>): string[] {
  const problems: string[] = [];

  if (
    report.restore === undefined ||
    !Number.isFinite(report.restore.tookMs) ||
    (report.restore.tookMs ?? 0) <= 0
  ) {
    problems.push(
      'restore.tookMs must be a finite number greater than 0 (a restore without a timed RTO is not a drill)',
    );
  }
  if (report.restore === undefined || !((report.restore.dataSizeBytes ?? 0) > 0)) {
    problems.push('restore.dataSizeBytes must be greater than 0 (missing source data size)');
  }
  if (report.restore === undefined || !((report.restore.restoredDataSizeBytes ?? 0) > 0)) {
    problems.push(
      'restore.restoredDataSizeBytes must be greater than 0 (missing restored data size)',
    );
  }

  // v2-only: the backup phase itself must be timed and sized - a restore
  // drill without a timed backup phase is not a drill. v1 reports (pg_dump
  // mode, already timed by `--backup-ms`/`--backup-bytes` since P26) skip
  // this rule unchanged, so an old report never regresses.
  if (report.schemaVersion === 2) {
    if (report.backup === undefined || !((report.backup.tookMs ?? 0) > 0)) {
      problems.push(
        'backup.tookMs must be greater than 0 (a restore drill without a timed backup phase is not a drill)',
      );
    }
    if (report.backup === undefined || !((report.backup.bytes ?? 0) > 0)) {
      problems.push(
        'backup.bytes must be greater than 0 (a restore drill without a timed backup phase is not a drill)',
      );
    }
  }

  const schemaVersion = report.verification?.schemaVersion;
  if (
    schemaVersion === undefined ||
    !schemaVersion.ok ||
    schemaVersion.actual !== schemaVersion.expected
  ) {
    problems.push(
      `verification.schemaVersion mismatch: expected ${String(schemaVersion?.expected)}, actual ${String(schemaVersion?.actual)}`,
    );
  }

  const tables = report.verification?.tables ?? [];
  for (const table of tables) {
    if (table.sourceRows !== table.restoredRows) {
      problems.push(
        `table "${table.name}" row count mismatch: source ${String(table.sourceRows)}, restored ${String(table.restoredRows)}`,
      );
    }
  }

  const parity = report.verification?.parity;
  if (parity !== undefined) {
    for (const entry of parity) {
      if (entry.exists && entry.sourceRows !== entry.restoredRows) {
        problems.push(
          `named table "${entry.name}" parity mismatch: source ${String(entry.sourceRows)}, restored ${String(entry.restoredRows)}`,
        );
      }
    }
  }

  const ledgerChain = report.verification?.ledgerChain;
  if (ledgerChain !== undefined && ledgerChain.breaks !== 0) {
    problems.push(
      `verification.ledgerChain found ${String(ledgerChain.breaks)} break(s) in balance_after_minor continuity`,
    );
  }

  const claimQuery = report.verification?.claimQuery;
  if (claimQuery === undefined || claimQuery.rowsReturned < 1) {
    // MINOR d fix (FIX-P26-H, 2026-09-07): append `claimQuery.note` so the
    // FAIL line an operator reads first states WHY, not just that it failed.
    const noteSuffix = claimQuery === undefined ? '' : `: ${claimQuery.note}`;
    problems.push(
      'verification.claimQuery.rowsReturned must be >= 1 (the claim path was never proven on ' +
        `the restored copy)${noteSuffix}`,
    );
  }

  const plaintextScan = report.verification?.plaintextScan;
  if (
    plaintextScan === undefined ||
    plaintextScan.blobHits !== 0 ||
    plaintextScan.dumpFileHits !== 0
  ) {
    problems.push(
      'verification.plaintextScan found a plaintext credential hit (blobHits/dumpFileHits must both be 0)',
    );
  }

  // recovery.ok / rto.ok are recorded honestly but are NOT FAIL rules - an
  // RTO/RPO miss is stated as a `notes` entry by the caller, next to the
  // target, never smoothed over and never silently promoted to PASS either
  // (see `formatRestoreDrillMarkdown`, which always prints both figures
  // beside their targets regardless of `ok`).

  return problems;
}

/**
 * Validates a `RestoreDrillReport`-shaped `input`, returning every problem
 * by name (never just a boolean) - see `computeRestoreDrillProblems` for the
 * shared rule set. A report that claims `verdict: 'PASS'` while problems
 * exist is ITSELF a problem (a report is not allowed to disagree with its
 * own rules).
 */
export function validateRestoreDrillReport(input: unknown): { ok: boolean; problems: string[] } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, problems: ['report is not an object'] };
  }
  const report = input as Partial<RestoreDrillReport>;
  const problems = computeRestoreDrillProblems(report);

  if (report.verdict === 'PASS' && problems.length > 0) {
    problems.push(
      'report claims verdict "PASS" but the computed rules found problems - a report must never disagree with its own rules',
    );
  }
  if (report.verdict === 'FAIL' && problems.length === 0) {
    problems.push(
      'report claims verdict "FAIL" but the computed rules found no problems - a report must never disagree with its own rules',
    );
  }

  return { ok: problems.length === 0, problems };
}

export {
  formatRestoreDrillMarkdown,
  type FormattableRestoreDrillReport,
} from './restore-drill-report-markdown.js';

interface CliArgs {
  mode: 'validate' | 'markdown';
  reportPath: string;
  outPath?: string;
}

function parseCliArgs(argv: string[]): CliArgs | undefined {
  if (argv[0] === '--validate' && argv[1] !== undefined) {
    return { mode: 'validate', reportPath: argv[1] };
  }
  if (argv[0] === '--markdown' && argv[1] !== undefined && argv[2] !== undefined) {
    return { mode: 'markdown', reportPath: argv[1], outPath: argv[2] };
  }
  return undefined;
}

async function runCli(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  if (args === undefined) {
    console.error(
      'usage: restore-drill-report.ts --validate <report.json> | --markdown <report.json> <out.md>',
    );
    return 1;
  }

  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(args.reportPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (args.mode === 'validate') {
    const { ok, problems } = validateRestoreDrillReport(parsed);
    for (const problem of problems) {
      console.error(`PROBLEM: ${problem}`);
    }
    console.log(ok ? 'VALID' : 'INVALID');
    return ok ? 0 : 1;
  }

  const markdown = formatRestoreDrillMarkdown(parsed as FormattableRestoreDrillReport);
  writeFileSync(args.outPath as string, markdown, 'utf8');
  console.log(`wrote ${args.outPath as string}`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
