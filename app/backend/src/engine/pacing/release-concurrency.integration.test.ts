import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { release, reserve } from './index.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  seedPacingMessageJob,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * release-concurrency.integration.test.ts (P13 C2 hardening) - the double-
 * refund race the sibling `deferral-release-and-unknown.integration.test.ts`
 * proves only SEQUENTIALLY (`first` awaited, then `second`). Two REAL
 * concurrent `release()` calls for the SAME job must still only ever
 * refund once - `message_jobs.pacing_refunded_at`'s conditional UPDATE
 * (`WHERE ... AND pacing_refunded_at IS NULL`) is the enforcing mechanism,
 * proved here under genuine parallelism (`Promise.all`), not merely
 * assumed from the sequential case. Also proves a release racing a FRESH
 * reserve for the same ledger row never corrupts either counter - the
 * concurrency invariant asserted is the EXACT resulting count, never a
 * sampled/bounded outcome.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-release-concurrency-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('release() under real concurrency', () => {
  it('ten_parallel_release_calls_for_the_same_job_refund_exactly_once', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 10,
    });
    const jobId = await seedPacingMessageJob(pool, { clientId, instanceId });

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: true,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        release({
          sql: pool,
          clientId,
          instanceId,
          ledgerDate: outcome.ledgerDate,
          messageJobId: jobId,
          isNewConversation: true,
          isGroup: false,
          isExempt: false,
          gapMs: 0,
        }),
      ),
    );

    const refundedCount = results.filter((r) => r.refunded).length;
    // The concurrency invariant itself, enforced by message_jobs'
    // conditional UPDATE ... WHERE pacing_refunded_at IS NULL - EXACTLY one
    // of the ten racing calls wins, never zero, never more than one.
    expect(refundedCount).toBe(1);

    const ledger = await pool.query<{
      consumed_count: number;
      new_conv_count: number;
      refund_count: number;
    }>(
      'SELECT consumed_count, new_conv_count, refund_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    // consumed_count/new_conv_count decremented exactly ONCE despite ten
    // concurrent callers - a double-refund would show consumed_count
    // clamped at 0 by GREATEST() masking the bug; refund_count is the
    // tell: it must also be exactly 1, never 10.
    expect(ledger.rows[0]?.consumed_count).toBe(0);
    expect(ledger.rows[0]?.new_conv_count).toBe(0);
    expect(ledger.rows[0]?.refund_count).toBe(1);

    const job = await pool.query<{ pacing_refunded_at: Date | null }>(
      'SELECT pacing_refunded_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(job.rows[0]?.pacing_refunded_at).not.toBeNull();
  });

  it('a_release_racing_fresh_reserves_on_the_same_ledger_row_never_loses_or_double_counts_an_update', async () => {
    // NOTE ON DETERMINISM: which of the nine racing reserve() calls a
    // concurrent release() happens to interleave with (and therefore
    // whether MIN_GAP/HOURLY_CAP denies a given one, since a granted
    // reserve's own gap/hour bookkeeping shifts depending on commit order)
    // is a GENUINE race outcome, not a fixed count - asserting a specific
    // number of the nine WOULD be exactly the sampled-race-outcome
    // assertion the ABSOLUTE RULE forbids (an earlier version of this test
    // did that and was observed to return 4, 5, 8, and 9 across repeated
    // runs of the identical code, proving the count itself is not
    // deterministic). The DETERMINISTIC invariant instead: the final
    // ledger row is EXACTLY consistent with the set of outcomes this
    // process itself observed - no update from any of the ten concurrent
    // callers was lost, and none was double-applied. That is computed
    // per-run from the callers' own returned outcomes (never from a
    // hardcoded expected count) and enforced as an exact equality.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 100,
      hourlyCap: 100,
      coldRatioMax: 1,
      coldRatioFloor: 1000,
    });
    const jobId = await seedPacingMessageJob(pool, { clientId, instanceId });

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;
    expect(outcome.nextEligibleAt).toBeTruthy();

    // Race: one release() of the FIRST reservation, plus nine fresh
    // reserve() calls, all concurrently against the same ledger row.
    const [releaseResult, ...reserveResults] = await Promise.all([
      release({
        sql: pool,
        clientId,
        instanceId,
        ledgerDate: outcome.ledgerDate,
        messageJobId: jobId,
        isNewConversation: false,
        isGroup: false,
        isExempt: false,
        gapMs: 0,
      }),
      ...Array.from({ length: 9 }, () =>
        reserve({
          sql: pool,
          clientId,
          instanceId,
          isNewConversation: false,
          isGroup: false,
          gapMs: 0,
          clock: fixedClock,
          timeZone: 'Asia/Kolkata',
        }),
      ),
    ]);

    expect(releaseResult.refunded).toBe(true);
    const grantedCount = reserveResults.filter((r) => r.granted).length;
    // Every one of the nine racing reserves is independently eligible
    // (dailyCap/hourlyCap are both 100, gap is 0) EXCEPT for whatever
    // MIN_GAP/HOURLY_CAP/UNKNOWN bookkeeping shift the race itself
    // introduces (UNKNOWN is reserve()'s own documented fail-closed
    // outcome for a genuine concurrent-race contradiction between the
    // reserve statement and its deny-reason follow-up SELECT - see
    // engine/pacing/index.ts's own module doc) - never zero, never denied
    // by DAILY_CAP (the invariant this specific test targets is "no
    // lost/double update", not "every racer wins").
    expect(grantedCount).toBeGreaterThan(0);
    for (const r of reserveResults) {
      if (!r.granted) {
        expect(['MIN_GAP', 'HOURLY_CAP', 'UNKNOWN']).toContain(r.reason);
      }
    }

    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    // The exact, deterministic invariant: 1 (original grant) - 1 (this
    // release, which DID refund) + however many of the nine racers this
    // exact run actually granted - computed from THIS run's own observed
    // outcomes, never a hardcoded count. A lost update or a double-refund
    // would make this arithmetic disagree with the real row.
    expect(ledger.rows[0]?.consumed_count).toBe(1 - 1 + grantedCount);
  });
});
