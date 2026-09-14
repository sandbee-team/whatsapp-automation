import { describe, expect, it, vi } from 'vitest';
import { deriveAdr0018Tier, runClaimCheck } from './run-restore-verify-checks.js';

/**
 * run-restore-verify-checks.test.ts (P26 C1 fix round, FIX-C MINOR e; P26
 * restore-drill-verifier defect-2 fix, 2026-09-07 adds `runClaimCheck`) -
 * `deriveAdr0018Tier`'s own unit test: exact tier bands derived from the
 * RESTORED `whatsapp_instances` count, never the hardcoded `'<=2000'`
 * `run-restore-verify.ts` used to write regardless of what was restored.
 * Does not reach `@wp/server-kit` (only `node:test` builtins - this module
 * has no runtime import besides `@wp/db` types), so no
 * `stub-wp-server-kit-env` import is needed here.
 *
 * `runClaimCheck`'s tests use a hand-rolled fake `Pool` (`.query`/`.connect`
 * only, matching the two methods the function under test actually calls) -
 * no real Postgres, proving the SQL TEXT bound to the mirrored predicate
 * (`priority_rank = ANY($1)` with the three real DWRR bands) and the exact
 * fallback note text when the fake source returns zero picked rows.
 */

interface FakeQueryCall {
  text: string;
  params: unknown[] | undefined;
}

function buildFakePool(pickedRows: unknown[], claimedRows: unknown[]) {
  const calls: FakeQueryCall[] = [];
  const clientQuery = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.startsWith('SELECT ils.client_id') || text.includes('FROM message_jobs j')) {
      return { rows: pickedRows };
    }
    if (/^\s*WITH eligible AS/.test(text)) {
      return { rows: claimedRows };
    }
    return { rows: [] };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const poolQuery = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows: pickedRows };
  });
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => client),
  };
  return { pool, calls, client };
}

describe('deriveAdr0018Tier', () => {
  it('bands_at_the_exact_adr_0018_section_7_boundaries', () => {
    expect(deriveAdr0018Tier(0)).toEqual({
      tier: '<=2000',
      claimedRto: '~1 h at <= 2,000 connected',
    });
    expect(deriveAdr0018Tier(2000)).toEqual({
      tier: '<=2000',
      claimedRto: '~1 h at <= 2,000 connected',
    });
    expect(deriveAdr0018Tier(2001)).toEqual({
      tier: '5000',
      claimedRto: '4-6 h at 10,000 from backup (5,000 band)',
    });
    expect(deriveAdr0018Tier(5000)).toEqual({
      tier: '5000',
      claimedRto: '4-6 h at 10,000 from backup (5,000 band)',
    });
    expect(deriveAdr0018Tier(5001)).toEqual({
      tier: '10000',
      claimedRto: '4-6 h at 10,000 from backup',
    });
    expect(deriveAdr0018Tier(10_000)).toEqual({
      tier: '10000',
      claimedRto: '4-6 h at 10,000 from backup',
    });
  });
});

describe('runClaimCheck', () => {
  it('picks_a_row_and_binds_only_the_real_dwrr_band_ranks', async () => {
    const pickedRow = {
      client_id: 'client-1',
      instance_id: 'instance-1',
      current_fence: '2',
      priority_rank: 3,
    };
    const { pool, calls } = buildFakePool([pickedRow], [{ id: 'job-1' }]);

    const result = await runClaimCheck(pool as never);

    expect(result).toEqual({
      rowsReturned: 1,
      ok: true,
      note: 'ran as the superuser connection (RLS FORCEd but bypassed by superuser); claimed inside BEGIN...ROLLBACK, never committed',
    });

    const pickCall = calls.find((c) => c.text.includes('FROM message_jobs j'));
    expect(pickCall).toBeDefined();
    // The real DWRR bands (HIGH:NORMAL:LOW = 6:3:1), never the 10/20/30
    // `Queue Fixture Client` leftover ranks - see DEFAULT_BAND_WEIGHTS.
    expect(pickCall?.params).toEqual([[6, 3, 1]]);
    expect(pickCall?.text).toContain("i.health_state    = 'connected'");
    // claim-jobs.sql binds the caller's fence in the CLAIM step (`ls.current_fence = $fence`); the pick must
    // NOT compare the fence to the session epoch - that predicate exists nowhere in production and
    // made drills #2-#4 report 0 claimable rows while ~98k queued rows satisfied the real predicate.
    expect(pickCall?.text).not.toContain('current_fence = j.session_epoch');
    expect(pickCall?.text).toContain('i.session_epoch   = j.session_epoch');
  });

  it('reports_a_named_note_when_no_claimable_job_existed_rather_than_a_bare_zero', async () => {
    const { pool } = buildFakePool([], []);

    const result = await runClaimCheck(pool as never);

    expect(result).toEqual({
      rowsReturned: 0,
      ok: false,
      note: 'no claimable job existed in the source at dump time - claim path not exercised',
    });
  });
});
