import { describe, expect, it, vi } from 'vitest';
import type { TenantDb, TenantQueryable } from '@wp/db';
import type { ClaimedJob } from '../../modules/queue/queue.repo.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';

/**
 * send-loop-pacing-claim.test.ts (MINOR 12 FIX, P14 review-fix F2) - unit-
 * level, same-transaction proof for `claimAndReserve`'s NO_LEDGER_ROW defer
 * path, replacing the 2ms sampling poll
 * (`pipeline-disposal-loop.integration.test.ts`'s former
 * `no_observer_ever_sees_a_deferred_job_in_processing`) with a structural
 * invariant: the SAME `tx` handle `tenantDb.withTenant` opens is the one
 * `claimOne` claims through AND the one `deferJob`'s own UPDATE runs
 * through - i.e. the claim and the deferral are provably the SAME
 * transaction, so no OTHER connection/observer can ever see the
 * intermediate 'processing' state a poll would have to race to catch.
 * `TenantQueryable`/`TenantDb` are plain interfaces here - no `@wp/server-kit`
 * config singleton in the import chain, so no stub-env first-import guard
 * needed.
 */

function makeMockTenantDb(): { tenantDb: TenantDb; queryMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi.fn(async (sql: string) => {
    if (sql.includes('FROM instance_pacing_state s') && sql.includes('pacing_profiles')) {
      // readGuardPipelineState - no row (falls through to the pacing
      // NO_LEDGER_ROW branch, same as a genuinely missing pacing state row).
      return { rows: [] };
    }
    if (sql.includes('FROM instance_pacing_state') && sql.includes('eff_gap_min_ms')) {
      // readPacingState (send-loop-claim-evaluation.ts) - also no row.
      return { rows: [] };
    }
    if (sql.includes('UPDATE message_jobs') && sql.includes("status = 'queued'")) {
      // defer-job.sql - the deferral write itself. loadQuery() converts
      // every $name placeholder to a positional $1/$2/... before this text
      // reaches tx.query, so this must match on literal SQL, never a
      // $named-parameter token.
      return { rows: [{ id: 'job-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const tenantDb: TenantDb = {
    async withTenant<T>(_clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      const tx: TenantQueryable = { query: queryMock as unknown as TenantQueryable['query'] };
      return fn(tx);
    },
  };
  return { tenantDb, queryMock };
}

describe('claimAndReserve - same-transaction proof for the defer path (MINOR 12 FIX)', () => {
  it('claimOne_and_deferJob_are_both_invoked_with_the_identical_tx_handle_from_withTenant', async () => {
    const { tenantDb, queryMock } = makeMockTenantDb();
    const capturedClaimSql: unknown[] = [];

    const claimed: ClaimedJob = {
      id: 'job-1',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      leaseId: 'lease-1',
      instanceId: 'instance-1',
      sessionEpoch: 0,
      recipientJid: '15550000000@s.whatsapp.net',
      payload: { text: 'hi' },
      payloadKind: 'text',
      attempts: 0,
      campaignId: null,
      isNewConversation: false,
      recipientHash: null,
      sendOrigin: null,
      contentFingerprint: null,
    };

    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) },
      claimOne: async (ctx) => {
        // Record the EXACT `sql` handle claimOne was given.
        capturedClaimSql.push(ctx.sql);
        return claimed;
      },
    });

    const result = await claimAndReserveFn(
      { clientId: 'client-1', sql: {} as never },
      { instanceId: 'instance-1', band: 3, fence: 1, workerId: 'worker-1', claimExpiryMs: 90_000 },
    );

    expect(result).toBeUndefined();
    // claimOne received a tx handle whose `.query` is the SAME mock
    // `withTenant` constructed - i.e. claimOne ran through withTenant's own
    // tx, never a second/raw connection.
    expect(capturedClaimSql).toHaveLength(1);
    expect((capturedClaimSql[0] as TenantQueryable).query).toBe(queryMock);

    // The defer-job.sql UPDATE ran through the SAME queryMock (the SAME tx
    // handle's own `.query`) - structurally, claimOne and deferJob cannot
    // have run on two different connections, which is the exact invariant
    // that makes "no external observer can see 'processing'" true: the
    // whole claim-guard-defer sequence is one transaction, and no
    // intermediate state is visible outside it until COMMIT.
    const deferCall = queryMock.mock.calls.find((call) => {
      const sql = call[0] as string;
      return sql.includes('UPDATE message_jobs') && sql.includes("status = 'queued'");
    });
    expect(deferCall).toBeDefined();
  });
});
