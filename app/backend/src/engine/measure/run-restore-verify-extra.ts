import { EXPECTED_SCHEMA_VERSION, type createPool } from '@wp/db';
import {
  computeRecoveryPoint,
  computeRto,
  evaluateLedgerChain,
  type LedgerRow,
} from '../../../../../scripts/ops/restore-drill-metrics.js';
import {
  computeRestoreDrillProblems,
  type RestoreDrillReport,
} from '../../../../../scripts/ops/restore-drill-report.js';
import type { BasebackupCliArgs } from './run-restore-verify.js';
import {
  countRows,
  deriveAdr0018Tier,
  listPublicTables,
  readDatabaseSizeBytes,
  readSchemaVersion,
  runClaimCheck,
  runPlaintextScan,
  SENTINELS,
  type Queryable,
} from './run-restore-verify-checks.js';

/**
 * run-restore-verify-extra.ts (P29a Unit U3, step 9) - the v2-report query
 * helpers for the `basebackup-scratch-container` (and, in shape only,
 * `pgbackrest-pitr`) restore modes: four-table named parity and the
 * wallet_ledger continuity check. Kept in its own sibling file (rather than
 * growing `run-restore-verify-checks.ts`, already at 252/300 lines) - pure
 * code-motion split, same idiom as the existing `-checks.ts` split.
 *
 * `evaluateLedgerChain` itself is PURE (`infra/backup/restore-drill-
 * metrics.ts`) - this file only owns the SQL that feeds it.
 */

/** The four named tables the phase's design calls out - `messages` does not exist in v1 (see `db/tests/grants-snapshot-p28-admin-role.test.ts` for the same statement). */
export const PARITY_TABLE_NAMES = [
  'message_jobs',
  'wallet_ledger',
  'messages',
  'contacts',
] as const;

export interface ParityEntry {
  name: string;
  sourceRows: number;
  restoredRows: number;
  exists: boolean;
}

/**
 * Named-table parity: for each of `PARITY_TABLE_NAMES`, counts rows on
 * BOTH pools directly (the basebackup mode has no snapshot-pinned counts
 * file - the restored copy IS a point-in-time snapshot of the source at
 * backup end, so a live count race is not a concern here the way it was for
 * the pg_dump mode's minutes-long window; see `run-restore-snapshot-
 * counts.ts`'s own header for that mode's different requirement).
 * `restoredTableNames` (from `listPublicTables` on the target) decides
 * `exists` - a table absent from the restored schema (namely `messages` in
 * v1) is reported with `exists: false` and both counts 0, never queried
 * (querying an absent table would throw).
 */
export async function computeParity(
  sourcePool: Queryable,
  targetPool: Queryable,
  restoredTableNames: readonly string[],
): Promise<ParityEntry[]> {
  const restoredSet = new Set(restoredTableNames);
  const entries: ParityEntry[] = [];
  for (const name of PARITY_TABLE_NAMES) {
    const exists = restoredSet.has(name);
    if (!exists) {
      entries.push({ name, sourceRows: 0, restoredRows: 0, exists: false });
      continue;
    }
    const [sourceRows, restoredRows] = await Promise.all([
      countRows(sourcePool, name),
      countRows(targetPool, name),
    ]);
    entries.push({ name, sourceRows, restoredRows, exists: true });
  }
  return entries;
}

/**
 * Runs the wallet_ledger continuity check on the RESTORED database (proving
 * the restore preserved the append-only ledger's invariant, not just its row
 * count) and reduces it through the pure `evaluateLedgerChain`.
 */
export async function runLedgerChainCheck(
  targetPool: Queryable,
): Promise<RestoreDrillReport['verification']['ledgerChain']> {
  const result = await targetPool.query<LedgerRow>(
    'SELECT client_id, seq, amount_minor, balance_after_minor FROM wallet_ledger ORDER BY client_id, seq',
  );
  const chain = evaluateLedgerChain(result.rows);
  return {
    clientsChecked: chain.clientsChecked,
    rowsChecked: chain.rowsChecked,
    breaks: chain.breaks.length,
    ok: chain.breaks.length === 0,
  };
}

type Pool = ReturnType<typeof createPool>;

/**
 * When `baseTarPath` is given, delegates to the shared `runPlaintextScan`
 * (DB blob scan + streaming file scan, identical to the pg_dump mode). When
 * omitted (the orchestrator did not pass `--base-tar`), runs ONLY the DB
 * blob scan and reports `dumpFileHits: 0` honestly - never a fabricated
 * "scanned" claim for a file that was never read.
 */
async function buildPlaintextScan(
  targetPool: Pool,
  baseTarPath: string | undefined,
): Promise<RestoreDrillReport['verification']['plaintextScan']> {
  if (baseTarPath !== undefined) {
    return runPlaintextScan(targetPool, baseTarPath);
  }
  let blobHits = 0;
  for (const sentinel of SENTINELS) {
    const result = await targetPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM whatsapp_session_credentials
        WHERE position(convert_to($1, 'UTF8') in ciphertext) > 0`,
      [sentinel],
    );
    blobHits += Number(result.rows[0]?.count ?? '0');
  }
  return { sentinels: [...SENTINELS], blobHits, dumpFileHits: 0, ok: blobHits === 0 };
}

/**
 * Builds the `basebackup-scratch-container` mode's report. No dump file, no
 * snapshot-pinned counts file (the restored copy IS the source at backup
 * end - see `computeParity`'s own comment) and no `--backup-ms`/
 * `--backup-bytes` CLI figures (the restore IS the base backup; its size
 * comes from `pg_database_size`, matching the pg_dump mode's own field).
 * `restoreStartIso`/`capturedAtIso` (as "verified at") feed `computeRto`;
 * `backupEndIso`/`capturedAtIso` (as "drill start") feed
 * `computeRecoveryPoint` under the `recovery_target = 'immediate'` caveat
 * documented on `computeRecoveryPoint` itself.
 */
export async function buildBasebackupReport(
  args: BasebackupCliArgs,
  sourcePool: Pool,
  targetPool: Pool,
  sourceInfo: { host: string; database: string },
  targetInfo: { host: string; database: string },
): Promise<RestoreDrillReport> {
  const sourceSchemaVersion = await readSchemaVersion(sourcePool);
  const targetSchemaVersion = await readSchemaVersion(targetPool);

  // Every-table parity: SOURCE counts vs RESTORED counts (P29a C1 CRITICAL
  // fix, 2026-09-09 - the first cut read both sides from the restored copy,
  // so every row of `tables` compared a number with itself and the validator's
  // mismatch rule could never fire). The source is read live at verify time,
  // i.e. backup-duration + restore-duration after the backup's consistency
  // point, so a concurrent writer on the source CAN move a count in between
  // and the drill then FAILs honestly (the operator re-runs on a quiet
  // source). The pg_dump mode avoids this window with a snapshot-pinned
  // counts file; a physical base backup has no equivalent export, so the
  // window is documented here rather than hidden by a self-comparison.
  const restoredTables = await listPublicTables(targetPool);
  const sourceTables = await listPublicTables(sourcePool);
  const allTableNames = [...new Set([...sourceTables, ...restoredTables])].sort();
  const restoredCountsByTable = new Map<string, number>();
  const tables: RestoreDrillReport['verification']['tables'] = [];
  for (const name of allTableNames) {
    const sourceRows = sourceTables.includes(name) ? await countRows(sourcePool, name) : 0;
    const restoredRows = restoredTables.includes(name) ? await countRows(targetPool, name) : 0;
    restoredCountsByTable.set(name, restoredRows);
    tables.push({ name, sourceRows, restoredRows });
  }

  const dataSizeBytes = await readDatabaseSizeBytes(sourcePool, sourceInfo.database);
  const restoredDataSizeBytes = await readDatabaseSizeBytes(targetPool, targetInfo.database);

  const claimQuery = await runClaimCheck(targetPool);
  const plaintextScan = await buildPlaintextScan(targetPool, args.baseTarPath);
  const parity = await computeParity(sourcePool, targetPool, restoredTables);
  const ledgerChain = await runLedgerChainCheck(targetPool);

  // Same MINOR (e) discipline as the pg_dump mode: derived from the
  // RESTORED whatsapp_instances count (already read above into `tables`),
  // never a hardcoded '<=2000'.
  const restoredInstanceCount =
    tables.find((t) => t.name === 'whatsapp_instances')?.restoredRows ?? 0;

  const verifiedAtIso = args.capturedAtIso;
  const rto = computeRto({ restoreStartIso: args.restoreStartIso, verifiedAtIso });
  const recovery = computeRecoveryPoint({
    backupEndIso: args.backupEndIso,
    lastReplayIso: null,
    drillStartIso: args.restoreStartIso,
  });

  const reportWithoutVerdict: Omit<RestoreDrillReport, 'verdict' | 'problems'> = {
    schemaVersion: 2,
    kind: 'restore-drill',
    capturedAtIso: args.capturedAtIso,
    source: {
      host: sourceInfo.host,
      database: sourceInfo.database,
      schemaVersion: sourceSchemaVersion,
    },
    backup: {
      tool: 'pg_basebackup',
      format: 'tar',
      compression: 'none',
      // Real on-disk size of the produced tars (`base.tar` + `pg_wal.tar`),
      // measured by the orchestrator and passed through via `--backup-bytes`
      // - never `dataSizeBytes` (the LIVE database size is a different
      // quantity than the backup artifact's size on disk, even though they
      // are close in a `pg_basebackup -Ft` backup). Falls back to
      // `dataSizeBytes` only for a caller that omits the flag (older
      // invocations), reported honestly rather than a fabricated 0.
      bytes: args.backupBytes ?? dataSizeBytes,
      tookMs: args.backupMs ?? 0,
      path: '(scratch container - see infra/backup/restore-drill.ts)',
    },
    restore: {
      tool: 'postgres-crash-recovery',
      mode: 'basebackup-scratch-container',
      target: targetInfo,
      tookMs: rto.rtoMs,
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
      parity,
      ledgerChain,
      claimQuery,
      plaintextScan,
    },
    recovery,
    rto,
    adr0018Tier: deriveAdr0018Tier(restoredInstanceCount),
    notes: [
      `RTO target ok=${String(rto.ok)}; RPO target ok=${String(recovery.ok)} (see docs/evidence/P29-restore-drill.md for the honest delta if either misses)`,
    ],
  };

  const problems = computeRestoreDrillProblems(reportWithoutVerdict);
  return { ...reportWithoutVerdict, verdict: problems.length === 0 ? 'PASS' : 'FAIL', problems };
}
