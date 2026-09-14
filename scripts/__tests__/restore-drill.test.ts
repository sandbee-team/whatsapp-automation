import { describe, expect, it } from 'vitest';
import {
  ADR_0018_TIER_CLAIM,
  INTERNAL_BANNER,
  formatRestoreDrillMarkdown,
  validateRestoreDrillReport,
  type FormattableRestoreDrillReport,
  type RestoreDrillReport,
} from '../ops/restore-drill-report.js';

/**
 * restore-drill.test.ts (P26 Unit U7, step 7) - pure tests for the restore
 * drill report schema/validator/markdown formatter. No `pg`, no real
 * database - `scripts/__tests__` is the root vitest project, which sets no
 * `WP_*` env and must never need it (this module imports Node builtins
 * only).
 */

function buildPassFixture(): RestoreDrillReport {
  return {
    schemaVersion: 1,
    kind: 'restore-drill',
    capturedAtIso: '2026-09-07T12:00:00.000Z',
    source: { host: '127.0.0.1:55432', database: 'wp', schemaVersion: 69 },
    backup: {
      tool: 'pg_dump',
      format: 'custom',
      compression: 'none',
      bytes: 10_485_760,
      tookMs: 4_200,
      path: 'C:\\Temp\\wp-restore-drill-20260907-120000.dump',
    },
    restore: {
      tool: 'pg_restore',
      mode: 'pg_dump',
      target: { host: '127.0.0.1:55432', database: 'wp_restore_drill_20260907_120000' },
      tookMs: 65_000,
      dataSizeBytes: 20_000_000,
      restoredDataSizeBytes: 20_000_000,
    },
    verification: {
      schemaVersion: { expected: 69, actual: 69, ok: true },
      tables: [
        { name: 'clients', sourceRows: 12, restoredRows: 12 },
        { name: 'message_jobs', sourceRows: 120, restoredRows: 120 },
      ],
      parity: [
        { name: 'message_jobs', sourceRows: 120, restoredRows: 120, exists: true },
        { name: 'wallet_ledger', sourceRows: 5, restoredRows: 5, exists: true },
        { name: 'messages', sourceRows: 0, restoredRows: 0, exists: false },
        { name: 'contacts', sourceRows: 3, restoredRows: 3, exists: true },
      ],
      ledgerChain: { clientsChecked: 1, rowsChecked: 5, breaks: 0, ok: true },
      claimQuery: {
        rowsReturned: 1,
        ok: true,
        note: 'claimed under wp_scheduler-equivalent bind set, rolled back',
      },
      plaintextScan: {
        sentinels: ['noiseKey', 'signedIdentityKey', 'registrationId', 'advSecretKey'],
        blobHits: 0,
        dumpFileHits: 0,
        ok: true,
      },
    },
    recovery: {
      recoveryPointIso: '2026-09-07T12:00:00.000Z',
      rpoSeconds: 30,
      rpoTargetSeconds: 300,
      ok: true,
    },
    rto: { rtoMs: 65_000, rtoTargetMs: 3_600_000, ok: true },
    adr0018Tier: { tier: '<=2000', claimedRto: '~1 h at <= 2,000 connected' },
    verdict: 'PASS',
    problems: [],
    notes: ['pg_restore --jobs=4'],
  };
}

describe('restore drill report', () => {
  it('restore_report_requires_a_timed_rto_and_the_restored_data_size', () => {
    const pass = buildPassFixture();
    expect(validateRestoreDrillReport(pass).ok).toBe(true);

    const zeroRto: RestoreDrillReport = {
      ...pass,
      restore: { ...pass.restore, tookMs: 0 },
    };
    const zeroRtoResult = validateRestoreDrillReport(zeroRto);
    expect(zeroRtoResult.ok).toBe(false);
    expect(zeroRtoResult.problems.some((p) => p.includes('timed RTO'))).toBe(true);

    const zeroDataSize: RestoreDrillReport = {
      ...pass,
      restore: { ...pass.restore, dataSizeBytes: 0 },
    };
    const zeroDataSizeResult = validateRestoreDrillReport(zeroDataSize);
    expect(zeroDataSizeResult.ok).toBe(false);
    expect(zeroDataSizeResult.problems.some((p) => p.includes('data size'))).toBe(true);

    const missingRestore = { ...pass } as Partial<RestoreDrillReport>;
    delete missingRestore.restore;
    expect(validateRestoreDrillReport(missingRestore).ok).toBe(false);
  });

  it('a_row_count_mismatch_is_rejected', () => {
    const pass = buildPassFixture();
    const mismatched: RestoreDrillReport = {
      ...pass,
      verdict: 'FAIL',
      verification: {
        ...pass.verification,
        tables: [{ name: 'message_jobs', sourceRows: 120, restoredRows: 119 }],
      },
    };
    const result = validateRestoreDrillReport(mismatched);
    expect(result.ok).toBe(false);
    const mismatchProblems = result.problems.filter((p) => p.includes('message_jobs'));
    expect(mismatchProblems.length).toBe(1);
  });

  it('a_plaintext_hit_or_a_schema_mismatch_fails_the_drill', () => {
    const pass = buildPassFixture();

    const blobHit: RestoreDrillReport = {
      ...pass,
      verdict: 'FAIL',
      verification: {
        ...pass.verification,
        plaintextScan: { ...pass.verification.plaintextScan, blobHits: 1 },
      },
    };
    expect(validateRestoreDrillReport(blobHit).ok).toBe(false);

    const schemaMismatch: RestoreDrillReport = {
      ...pass,
      verdict: 'FAIL',
      verification: {
        ...pass.verification,
        schemaVersion: { expected: 69, actual: 68, ok: false },
      },
    };
    expect(validateRestoreDrillReport(schemaMismatch).ok).toBe(false);

    const noClaimRows: RestoreDrillReport = {
      ...pass,
      verdict: 'FAIL',
      verification: {
        ...pass.verification,
        claimQuery: { rowsReturned: 0, ok: false, note: 'no eligible queued job existed' },
      },
    };
    const noClaimResult = validateRestoreDrillReport(noClaimRows);
    expect(noClaimResult.ok).toBe(false);
    // MINOR d fix (FIX-P26-H, 2026-09-07): the FAIL problem string must carry
    // `claimQuery.note` verbatim, so the line an operator reads first states
    // WHY the claim path was never proven, not just that it wasn't.
    expect(noClaimResult.problems).toContain(
      'verification.claimQuery.rowsReturned must be >= 1 (the claim path was never proven on ' +
        'the restored copy): no eligible queued job existed',
    );
  });

  it('a_report_claiming_pass_with_problems_is_itself_rejected', () => {
    const pass = buildPassFixture();
    const claimsPassButMismatched: RestoreDrillReport = {
      ...pass,
      verdict: 'PASS',
      verification: {
        ...pass.verification,
        tables: [{ name: 'message_jobs', sourceRows: 120, restoredRows: 119 }],
      },
    };
    const result = validateRestoreDrillReport(claimsPassButMismatched);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('verdict') && p.includes('PASS'))).toBe(true);
  });

  it('the_markdown_places_the_measured_rto_next_to_the_adr_0018_tier_claim', () => {
    const pass = buildPassFixture() as FormattableRestoreDrillReport;
    const markdown = formatRestoreDrillMarkdown(pass);

    expect(markdown).toContain(INTERNAL_BANNER);
    expect(markdown).toContain('ADR 0018 §7');
    expect(markdown).toContain(ADR_0018_TIER_CLAIM);
    expect(markdown).toContain('01:05');
    expect(markdown).toContain('<=2000');
    // ADR 0018 §8 / Gate-B clause (e): the page names the 10,000 tier, so it must carry the honest
    // sentence marker verbatim - the capacity gate guard fails the generated file without it.
    expect(markdown).toContain(
      'has been measured to the N stated in docs/capacity/fleet-capacity.md',
    );

    const rtoLineIndex = markdown.indexOf('Measured RTO');
    const tierClaimIndex = markdown.indexOf('ADR 0018 §7');
    expect(rtoLineIndex).toBeGreaterThanOrEqual(0);
    expect(tierClaimIndex).toBeGreaterThan(rtoLineIndex);
    expect(tierClaimIndex - rtoLineIndex).toBeLessThan(200);

    expect(markdown.toLowerCase()).not.toContain('password');
    expect(markdown).not.toMatch(/postgres:\/\/[^:]+:[^@]+@/);
  });
});
