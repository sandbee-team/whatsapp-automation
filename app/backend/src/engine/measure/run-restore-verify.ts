import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, EXPECTED_SCHEMA_VERSION } from '@wp/db';
import { describeError } from '@wp/server-kit';
import {
  computeRestoreDrillProblems,
  type RestoreDrillReport,
} from '../../../../../scripts/ops/restore-drill-report.js';
import type { SnapshotCountsFile } from './run-restore-snapshot-counts.js';
import {
  countRows,
  deriveAdr0018Tier,
  listPublicTables,
  readDatabaseSizeBytes,
  readSchemaVersion,
  runClaimCheck,
  runPlaintextScan,
} from './run-restore-verify-checks.js';
import { buildBasebackupReport } from './run-restore-verify-extra.js';

/**
 * run-restore-verify.ts (P26 Unit U7, step 7; P26 restore-drill-verifier
 * defect-1 fix, 2026-09-07 makes the table-count check race-free) - the
 * runnable restore-drill verifier. Connects to BOTH the source and the
 * restored-scratch database with real `pg`, fills every `verification`
 * field, and writes the report JSON. isMain-guarded (never runs on import) -
 * same idiom as `run-component-a.ts`. Invoked by `scripts/ops/restore-
 * drill.ps1` / `.sh`, never by application code (production src never
 * imports `engine/measure/**`, a dependency-cruiser rule).
 *
 * `verdict` is computed by the SAME rule set `scripts/ops/restore-drill-
 * report.ts`'s `--validate` CLI mode uses (`computeRestoreDrillProblems`) -
 * one rule set, never two, so this tool can never write a report that
 * disagrees with the validator that later checks it.
 *
 * `--source-counts <file>` is REQUIRED, not optional: it names the
 * `SnapshotCountsFile` `run-restore-snapshot-counts.ts` wrote from INSIDE
 * the same `pg_export_snapshot()` transaction `pg_dump --snapshot=<id>` ran
 * under - restored counts are compared to THAT file, never to a fresh live
 * query of the source. Comparing to a live query is exactly the bug this
 * fixes (a concurrent writer moves the source between dump time and verify
 * time, so live counts can never agree with a snapshot taken minutes
 * earlier - see `run-restore-snapshot-counts.ts`'s own header). Making the
 * flag required keeps the old racy path from ever being reachable again.
 *
 * Query helpers (claim-check, plaintext scan, table row counts) live in the
 * sibling `run-restore-verify-checks.ts` (pure code-motion split for the
 * `max-lines` cap).
 */

const USAGE =
  'usage: run-restore-verify.ts --source <url> --target <url> --dump <path> --out <report.json> ' +
  '--source-counts <counts.json> --backup-ms <n> --backup-bytes <n> --restore-ms <n> [--captured <iso>]\n' +
  '   or: run-restore-verify.ts --source <url> --target <url> --out <report.json> ' +
  '--mode basebackup-scratch-container --restore-start <iso> --backup-end <iso> ' +
  '[--backup-ms <n>] [--backup-bytes <n>] [--base-tar <path>]';

interface PgDumpCliArgs {
  reportMode: 'pg_dump';
  source: string;
  target: string;
  dump: string;
  out: string;
  sourceCountsPath: string;
  backupMs: number;
  backupBytes: number;
  restoreMs: number;
  capturedAtIso: string;
}

export interface BasebackupCliArgs {
  reportMode: 'basebackup-scratch-container';
  source: string;
  target: string;
  out: string;
  restoreStartIso: string;
  backupEndIso: string;
  capturedAtIso: string;
  /** The `base.tar` `pg_basebackup` wrote - scanned for plaintext key-ring sentinels, same as the pg_dump mode scans its `.dump` file. Optional: an empty scan (0 hits, honestly noted) if omitted. */
  baseTarPath?: string;
  /** Wall-clock time of the `pg_basebackup` step itself, measured by the orchestrator (`infra/backup/restore-drill-basebackup.ts`) - reused verbatim, never re-derived here. Optional for backward compatibility with older invocations; a missing value is reported as 0 honestly, never guessed. */
  backupMs?: number;
  /** On-disk size of the produced tar files (`base.tar` + `pg_wal.tar`), summed by the orchestrator. Same optionality as `backupMs`. */
  backupBytes?: number;
}

type CliArgs = PgDumpCliArgs | BasebackupCliArgs;

/**
 * Pure comparison: every table restored is checked against the SNAPSHOT
 * counts file (never a live query) - a table present in the snapshot but
 * missing from the restored list is reported as `restoredRows: 0` (a real
 * restore gap), and a table restored that the snapshot never counted (e.g.
 * created after the snapshot's `listPublicTables` ran, impossible within one
 * drill but defensive) is reported as `sourceRows: 0`.
 */
export function buildTableComparisons(
  sourceCounts: SnapshotCountsFile['tables'],
  restoredCountsByTable: ReadonlyMap<string, number>,
): RestoreDrillReport['verification']['tables'] {
  const names = new Set([...Object.keys(sourceCounts), ...restoredCountsByTable.keys()]);
  return [...names].sort().map((name) => ({
    name,
    sourceRows: sourceCounts[name] ?? 0,
    restoredRows: restoredCountsByTable.get(name) ?? 0,
  }));
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs | 'help' {
  if (argv.includes('--help')) {
    return 'help';
  }
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined) {
        map.set(key, val);
        i += 1;
      }
    }
  }
  const required = (key: string): string => {
    const value = map.get(key);
    if (value === undefined) {
      throw new Error(`run-restore-verify: missing required --${key}\n${USAGE}`);
    }
    return value;
  };
  // `--source`/`--target` OR RESTORE_DRILL_SOURCE_URL/RESTORE_DRILL_TARGET_URL
  // (flag wins; env is the fallback) - keeps a DSN out of argv/process listings.
  const requiredDsn = (
    flagKey: 'source' | 'target',
    envKey: 'RESTORE_DRILL_SOURCE_URL' | 'RESTORE_DRILL_TARGET_URL',
  ): string => {
    const value = map.get(flagKey) ?? env[envKey];
    if (value === undefined) {
      throw new Error(
        `run-restore-verify: missing required --${flagKey} (or ${envKey} env var)\n${USAGE}`,
      );
    }
    return value;
  };

  if (map.get('mode') === 'basebackup-scratch-container') {
    return {
      reportMode: 'basebackup-scratch-container',
      source: requiredDsn('source', 'RESTORE_DRILL_SOURCE_URL'),
      target: requiredDsn('target', 'RESTORE_DRILL_TARGET_URL'),
      out: required('out'),
      restoreStartIso: required('restore-start'),
      backupEndIso: required('backup-end'),
      capturedAtIso: map.get('captured') ?? new Date().toISOString(),
      baseTarPath: map.get('base-tar'),
      backupMs: map.has('backup-ms') ? Number(map.get('backup-ms')) : undefined,
      backupBytes: map.has('backup-bytes') ? Number(map.get('backup-bytes')) : undefined,
    };
  }

  return {
    reportMode: 'pg_dump',
    source: requiredDsn('source', 'RESTORE_DRILL_SOURCE_URL'),
    target: requiredDsn('target', 'RESTORE_DRILL_TARGET_URL'),
    dump: required('dump'),
    out: required('out'),
    sourceCountsPath: required('source-counts'),
    backupMs: Number(required('backup-ms')),
    backupBytes: Number(required('backup-bytes')),
    restoreMs: Number(required('restore-ms')),
    capturedAtIso: map.get('captured') ?? new Date().toISOString(),
  };
}

/** Never logs a password - host/database only, matching the report schema's own `source`/`target` fields. */
export function describeConnection(connectionString: string): { host: string; database: string } {
  const url = new URL(connectionString);
  return { host: url.host, database: url.pathname.replace(/^\//, '') };
}

async function buildReport(args: CliArgs): Promise<RestoreDrillReport> {
  const sourceInfo = describeConnection(args.source);
  const targetInfo = describeConnection(args.target);

  const sourcePool = createPool({
    connectionString: args.source,
    applicationName: 'restore-drill-verify-source',
  });
  const targetPool = createPool({
    connectionString: args.target,
    applicationName: 'restore-drill-verify-target',
  });

  try {
    if (args.reportMode === 'basebackup-scratch-container') {
      return await buildBasebackupReport(args, sourcePool, targetPool, sourceInfo, targetInfo);
    }
    const sourceSchemaVersion = await readSchemaVersion(sourcePool);
    const targetSchemaVersion = await readSchemaVersion(targetPool);

    const sourceCountsRaw = readFileSync(args.sourceCountsPath, 'utf8');
    const sourceCounts = JSON.parse(sourceCountsRaw) as SnapshotCountsFile;

    const restoredTables = await listPublicTables(targetPool);
    const restoredCountsByTable = new Map<string, number>();
    for (const name of restoredTables) {
      restoredCountsByTable.set(name, await countRows(targetPool, name));
    }
    const tables = buildTableComparisons(sourceCounts.tables, restoredCountsByTable);

    const dataSizeBytes = await readDatabaseSizeBytes(sourcePool, sourceInfo.database);
    const restoredDataSizeBytes = await readDatabaseSizeBytes(targetPool, targetInfo.database);

    const claimQuery = await runClaimCheck(targetPool);
    const plaintextScan = await runPlaintextScan(targetPool, args.dump);
    // MINOR (e): derived from the RESTORED whatsapp_instances count (already
    // read above into `tables`), never a hardcoded '<=2000'.
    const restoredInstanceCount =
      tables.find((t) => t.name === 'whatsapp_instances')?.restoredRows ?? 0;

    const reportWithoutVerdict: Omit<RestoreDrillReport, 'verdict' | 'problems'> = {
      schemaVersion: 1,
      kind: 'restore-drill',
      capturedAtIso: args.capturedAtIso,
      source: {
        host: sourceInfo.host,
        database: sourceInfo.database,
        schemaVersion: sourceSchemaVersion,
      },
      backup: {
        tool: 'pg_dump',
        format: 'custom',
        compression: 'none',
        bytes: args.backupBytes,
        tookMs: args.backupMs,
        path: args.dump,
      },
      restore: {
        tool: 'pg_restore',
        mode: 'pg_dump',
        target: targetInfo,
        tookMs: args.restoreMs,
        dataSizeBytes,
        restoredDataSizeBytes,
      },
      verification: {
        schemaVersion: {
          expected: EXPECTED_SCHEMA_VERSION,
          actual: targetSchemaVersion,
          ok: targetSchemaVersion === EXPECTED_SCHEMA_VERSION,
        },
        tables,
        claimQuery,
        plaintextScan,
      },
      adr0018Tier: deriveAdr0018Tier(restoredInstanceCount),
      notes: [],
    };

    const problems = computeRestoreDrillProblems(reportWithoutVerdict);
    return { ...reportWithoutVerdict, verdict: problems.length === 0 ? 'PASS' : 'FAIL', problems };
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }

  const report = await buildReport(parsed);
  writeFileSync(parsed.out, JSON.stringify(report, null, 2), 'utf8');
  console.log(
    `run-restore-verify: verdict=${report.verdict} rto=${String(report.restore.tookMs)}ms report=${parsed.out}`,
  );
  if (report.problems.length > 0) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err: unknown) => {
    console.error(describeError(err));
    process.exitCode = 1;
  });
}
