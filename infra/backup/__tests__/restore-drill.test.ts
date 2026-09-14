import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNotProductionTarget,
  evaluateLedgerChain,
  RestoreDrillRefusedError,
  type LedgerRow,
} from '../restore-drill-lib.js';
import { runRestoreDrill, type RestoreDrillCliArgs, type RunProcess } from '../restore-drill.js';
import {
  computeRestoreDrillProblems,
  validateRestoreDrillReport,
  type RestoreDrillReport,
} from '../../../scripts/ops/restore-drill-report.js';

/**
 * restore-drill.test.ts (P29a Unit U3, step 9) - pure/unit tests for the
 * restore drill lib, report v2 schema, and orchestrator refusal path. No
 * real Postgres/docker here (root vitest project, no `WP_*` env) - the real
 * drill is exercised for real once, separately, evidence read back below.
 */

function defaultArgs(overrides: Partial<RestoreDrillCliArgs> = {}): RestoreDrillCliArgs {
  return {
    mode: 'basebackup',
    scratchPort: 55499,
    keep: false,
    allowRemoteSource: false,
    pgBin: 'C:\\Program Files\\PostgreSQL\\17\\bin',
    outPath: 'ignored.json',
    markdownPath: 'ignored.md',
    ...overrides,
  };
}

function buildFakeRunProcess(calls: Array<{ command: string; argv: string[] }>): RunProcess {
  return async (command, argv) => {
    calls.push({ command, argv });
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('the restore drill refuses a production target', () => {
  it('the_restore_drill_refuses_a_production_target', async () => {
    const source = { host: '127.0.0.1', port: 55432, database: 'wp' };

    expect(() =>
      assertNotProductionTarget({ host: 'db.wp.internal', port: 55499, database: 'wp' }, source),
    ).toThrow(RestoreDrillRefusedError);

    expect(() =>
      assertNotProductionTarget(
        { host: '127.0.0.1', port: 55499, database: 'wp' },
        source,
        undefined,
        'prod-primary',
      ),
    ).toThrow(RestoreDrillRefusedError);

    expect(() =>
      assertNotProductionTarget({ host: '10.0.0.5', port: 55499, database: 'wp' }, source),
    ).toThrow(RestoreDrillRefusedError);

    expect(() =>
      assertNotProductionTarget({ host: '127.0.0.1', port: 55432, database: 'wp' }, source),
    ).toThrow(RestoreDrillRefusedError);

    expect(() =>
      assertNotProductionTarget({ host: '127.0.0.1', port: 55499, database: 'wp' }, source),
    ).not.toThrow();

    // The orchestrator itself: a production-looking target refuses BEFORE
    // any process is spawned - zero calls recorded is the proof "nothing
    // executed".
    const calls: Array<{ command: string; argv: string[] }> = [];
    const deps = {
      runProcess: buildFakeRunProcess(calls),
      env: {
        POSTGRES_HOST: 'db.wp.internal',
        POSTGRES_PORT: '55432',
        POSTGRES_USER: 'wp',
        POSTGRES_PASSWORD: 'x',
        POSTGRES_DB: 'wp',
      },
      out: vi.fn(),
      now: () => '2026-09-08T00:00:00.000Z',
      readFileSize: () => 0,
    };
    await expect(
      runRestoreDrill(defaultArgs({ productionHost: 'db.wp.internal' }), deps),
    ).rejects.toThrow(RestoreDrillRefusedError);
    expect(calls).toHaveLength(0);
  });
});

describe('a drill run asserts schema version and row count parity', () => {
  it('a_drill_run_asserts_schema_version_and_row_count_parity', () => {
    const base: RestoreDrillReport = {
      schemaVersion: 2,
      kind: 'restore-drill',
      capturedAtIso: '2026-09-08T00:00:00.000Z',
      source: { host: '127.0.0.1:55432', database: 'wp', schemaVersion: 75 },
      backup: {
        tool: 'pg_basebackup',
        format: 'tar',
        compression: 'none',
        bytes: 1000,
        tookMs: 5000,
        path: 'x',
      },
      restore: {
        tool: 'postgres-crash-recovery',
        mode: 'basebackup-scratch-container',
        target: { host: '127.0.0.1:55499', database: 'wp' },
        tookMs: 6000,
        dataSizeBytes: 1000,
        restoredDataSizeBytes: 1000,
      },
      verification: {
        schemaVersion: { expected: 75, actual: 75, ok: true },
        tables: [{ name: 'clients', sourceRows: 5, restoredRows: 5 }],
        parity: [
          { name: 'message_jobs', sourceRows: 10, restoredRows: 10, exists: true },
          { name: 'wallet_ledger', sourceRows: 20, restoredRows: 20, exists: true },
          { name: 'messages', sourceRows: 0, restoredRows: 0, exists: false },
          { name: 'contacts', sourceRows: 3, restoredRows: 3, exists: true },
        ],
        ledgerChain: { clientsChecked: 2, rowsChecked: 20, breaks: 0, ok: true },
        claimQuery: { rowsReturned: 1, ok: true, note: 'ok' },
        plaintextScan: { sentinels: ['noiseKey'], blobHits: 0, dumpFileHits: 0, ok: true },
      },
      recovery: {
        recoveryPointIso: '2026-09-08T00:00:00.000Z',
        rpoSeconds: 10,
        rpoTargetSeconds: 300,
        ok: true,
      },
      rto: { rtoMs: 6000, rtoTargetMs: 3_600_000, ok: true },
      adr0018Tier: { tier: '<=2000', claimedRto: '~1 h at <= 2,000 connected' },
      verdict: 'PASS',
      problems: [],
      notes: [],
    };

    expect(validateRestoreDrillReport(base).ok).toBe(true);

    const mismatched: RestoreDrillReport = {
      ...base,
      verdict: 'FAIL',
      verification: {
        ...base.verification,
        parity: base.verification.parity?.map((p) =>
          p.name === 'wallet_ledger' ? { ...p, restoredRows: 19 } : p,
        ),
      },
    };
    const mismatchedResult = validateRestoreDrillReport(mismatched);
    expect(mismatchedResult.ok).toBe(false);
    expect(mismatchedResult.problems.some((p) => p.includes('wallet_ledger'))).toBe(true);

    // messages with exists:false is never a problem on its own.
    const problemsForBase = computeRestoreDrillProblems(base);
    expect(problemsForBase).toEqual([]);

    const schemaMismatch: RestoreDrillReport = {
      ...base,
      verdict: 'FAIL',
      verification: {
        ...base.verification,
        schemaVersion: { expected: 75, actual: 74, ok: false },
      },
    };
    const schemaMismatchResult = validateRestoreDrillReport(schemaMismatch);
    expect(schemaMismatchResult.ok).toBe(false);
    expect(schemaMismatchResult.problems.some((p) => p.includes('schemaVersion mismatch'))).toBe(
      true,
    );
  });
});

describe('a drill run writes a timed evidence file with measured RTO and RPO', () => {
  it('a_drill_run_writes_a_timed_evidence_file_with_measured_rto_and_rpo', () => {
    const jsonPath = 'docs/measurements/2026-09-08-restore-drill.json';
    const mdPath = 'docs/evidence/P29-restore-drill.md';

    const raw = readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as RestoreDrillReport;

    const result = validateRestoreDrillReport(parsed);
    expect(result.ok).toBe(true);

    expect(parsed.rto?.rtoMs).toBeGreaterThan(0);
    expect(parsed.recovery?.rpoSeconds).toBeGreaterThanOrEqual(0);
    expect(() => new Date(parsed.capturedAtIso).toISOString()).not.toThrow();
    expect(parsed.restore.mode).toBe('basebackup-scratch-container');

    const markdown = readFileSync(mdPath, 'utf8');
    expect(markdown).toContain('Measured RTO');
    expect(markdown).toContain('Measured RPO');
    expect(markdown).toContain('INTERNAL');
    expect(markdown).not.toMatch(/postgres:\/\/[^"'\s]*@/);
  });
});

describe('the restored wallet ledger chain is continuous', () => {
  it('the_restored_wallet_ledger_chain_is_continuous', () => {
    const continuous: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
      { client_id: 'c1', seq: 2, amount_minor: -200, balance_after_minor: 800 },
      { client_id: 'c2', seq: 1, amount_minor: 500, balance_after_minor: 500 },
      { client_id: 'c2', seq: 2, amount_minor: 500, balance_after_minor: 1000 },
    ];
    const continuousResult = evaluateLedgerChain(continuous);
    expect(continuousResult.breaks).toEqual([]);
    expect(continuousResult.clientsChecked).toBe(2);
    expect(continuousResult.rowsChecked).toBe(4);

    const broken: LedgerRow[] = [
      { client_id: 'c1', seq: 1, amount_minor: 1000, balance_after_minor: 1000 },
      { client_id: 'c1', seq: 2, amount_minor: -200, balance_after_minor: 750 }, // wrong: should be 800
      { client_id: 'c2', seq: 1, amount_minor: 500, balance_after_minor: 500 },
      { client_id: 'c2', seq: 2, amount_minor: 500, balance_after_minor: 1000 },
    ];
    const brokenResult = evaluateLedgerChain(broken);
    expect(brokenResult.breaks).toEqual([
      { client_id: 'c1', seq: '2', expected: '800', actual: '750' },
    ]);

    const reportWithBreak: Partial<RestoreDrillReport> = {
      restore: {
        tool: 'postgres-crash-recovery',
        target: { host: 'x', database: 'y' },
        tookMs: 1,
        dataSizeBytes: 1,
        restoredDataSizeBytes: 1,
      },
      verification: {
        schemaVersion: { expected: 75, actual: 75, ok: true },
        tables: [],
        ledgerChain: { clientsChecked: 1, rowsChecked: 2, breaks: 1, ok: false },
        claimQuery: { rowsReturned: 1, ok: true, note: 'ok' },
        plaintextScan: { sentinels: [], blobHits: 0, dumpFileHits: 0, ok: true },
      },
    };
    const problems = computeRestoreDrillProblems(reportWithBreak);
    expect(problems.some((p) => p.includes('balance_after_minor'))).toBe(true);
  });
});
