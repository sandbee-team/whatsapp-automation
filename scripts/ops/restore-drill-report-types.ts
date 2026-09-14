/**
 * scripts/ops/restore-drill-report-types.ts (P29a C1 fix, 2026-09-09) - the
 * LEAF module for the restore-drill report: the shared constants and the
 * `RestoreDrillReport` shape, and nothing else. It exists to break the
 * import cycle `restore-drill-report.ts` -> `restore-drill-report-markdown.ts`
 * -> `restore-drill-report.ts` (depcruise `no-circular-scripts`): the
 * validator and the markdown formatter both import from here, and only the
 * validator imports the formatter (for its `--markdown` CLI mode).
 * `restore-drill-report.ts` re-exports everything below, so existing
 * importers keep working unchanged.
 */

export const ADR_0018_TIER_CLAIM =
  '~1 h at ≤ 2,000 connected · 4-6 h at 10,000 · ~15 min via promotion';

export const INTERNAL_BANNER =
  'INTERNAL — restore drill evidence; no figure here is quotable (ADR 0016)';

export interface RestoreDrillReport {
  schemaVersion: 1 | 2;
  kind: 'restore-drill';
  capturedAtIso: string;
  /** Never a password - host/database/schema version only. */
  source: { host: string; database: string; schemaVersion: number };
  backup: {
    tool: 'pg_dump' | 'pg_basebackup';
    format: 'custom' | 'tar';
    compression: 'none';
    bytes: number;
    tookMs: number;
    path: string;
  };
  restore: {
    tool: 'pg_restore' | 'postgres-crash-recovery';
    /** v2: which restore path produced this report. */
    mode?: 'pg_dump' | 'basebackup-scratch-container' | 'pgbackrest-pitr';
    target: { host: string; database: string };
    /** The measured RTO figure. */
    tookMs: number;
    /** `pg_database_size(source)` at drill time. */
    dataSizeBytes: number;
    restoredDataSizeBytes: number;
  };
  verification: {
    schemaVersion: { expected: number; actual: number; ok: boolean };
    /** Every `public` base table. */
    tables: Array<{ name: string; sourceRows: number; restoredRows: number }>;
    /** v2: the four named tables (message_jobs, wallet_ledger, messages, contacts). */
    parity?: Array<{ name: string; sourceRows: number; restoredRows: number; exists: boolean }>;
    /** v2: the wallet_ledger continuity check. */
    ledgerChain?: { clientsChecked: number; rowsChecked: number; breaks: number; ok: boolean };
    claimQuery: { rowsReturned: number; ok: boolean; note: string };
    plaintextScan: {
      sentinels: string[];
      blobHits: number;
      dumpFileHits: number;
      ok: boolean;
    };
  };
  /** v2: the recovery-point / RPO figure. */
  recovery?: {
    recoveryPointIso: string;
    rpoSeconds: number;
    rpoTargetSeconds: number;
    ok: boolean;
  };
  /** v2: the RTO figure, separate from `restore.tookMs` (restore-start -> verified, not just the restore step). */
  rto?: { rtoMs: number; rtoTargetMs: number; ok: boolean };
  adr0018Tier: { tier: '<=2000' | '5000' | '10000'; claimedRto: string };
  verdict: 'PASS' | 'FAIL';
  problems: string[];
  notes: string[];
}
