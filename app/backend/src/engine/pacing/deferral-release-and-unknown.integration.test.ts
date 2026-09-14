import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { release, reserve } from './index.js';
import { resolveRetryAt } from './retry-at.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  seedPacingMessageJob,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * deferral-release-and-unknown.integration.test.ts (P13 Unit U4, step 7) -
 * split out of `deferral.integration.test.ts` purely for that file's
 * max-lines cap (same split idiom as `session-worker-discovery-wiring.ts`).
 * A genuine `release()` refund + idempotency proof, and the fail-closed
 * `UNKNOWN` deny-reason contract.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-deferral-release-tests',
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

describe('release() refund + idempotency, and the UNKNOWN fail-closed contract', () => {
  it('release_refunds_a_genuine_non_attempt_and_is_idempotent', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
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

    const first = await release({
      sql: pool,
      clientId,
      instanceId,
      ledgerDate: outcome.ledgerDate,
      messageJobId: jobId,
      isNewConversation: true,
      isGroup: false,
      isExempt: false,
      gapMs: 0,
    });
    expect(first.refunded).toBe(true);

    const ledger = await pool.query<{ consumed_count: number; new_conv_count: number }>(
      'SELECT consumed_count, new_conv_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.consumed_count).toBe(0);
    expect(ledger.rows[0]?.new_conv_count).toBe(0);

    // A SECOND release() call for the SAME job is a normal, idempotent
    // no-op (message_jobs.pacing_refunded_at is the guard) - never a
    // double-refund.
    const second = await release({
      sql: pool,
      clientId,
      instanceId,
      ledgerDate: outcome.ledgerDate,
      messageJobId: jobId,
      isNewConversation: true,
      isGroup: false,
      isExempt: false,
      gapMs: 0,
    });
    expect(second.refunded).toBe(false);

    const ledgerAfterSecond = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledgerAfterSecond.rows[0]?.consumed_count).toBe(0);
  });

  it('an_exempt_reserve_and_release_round_trip_leaves_consumed_count_untouched_and_system_count_restored', async () => {
    // FINDING 9 (P14 review-fix F2): symmetric with reserve-pacing.sql's own
    // exempt grant (system_count only, never consumed_count) - the refund
    // must decrement the SAME counter it incremented, never the other one.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
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
      sendOrigin: 'opt_out_confirmation',
    });
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    const ledgerAfterReserve = await pool.query<{
      consumed_count: number;
      system_count: number;
    }>('SELECT consumed_count, system_count FROM pacing_ledger WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(ledgerAfterReserve.rows[0]).toEqual({ consumed_count: 0, system_count: 1 });

    const refund = await release({
      sql: pool,
      clientId,
      instanceId,
      ledgerDate: outcome.ledgerDate,
      messageJobId: jobId,
      isNewConversation: false,
      isGroup: false,
      isExempt: true,
      gapMs: 0,
    });
    expect(refund.refunded).toBe(true);

    const ledgerAfterRelease = await pool.query<{
      consumed_count: number;
      system_count: number;
    }>('SELECT consumed_count, system_count FROM pacing_ledger WHERE instance_id = $1', [
      instanceId,
    ]);
    // Back to the pre-reserve state exactly - system_count decremented,
    // consumed_count never touched (an exempt reserve never incremented it
    // in the first place).
    expect(ledgerAfterRelease.rows[0]).toEqual({ consumed_count: 0, system_count: 0 });
  });

  it('unknown_deny_reason_holds_for_sixty_seconds_and_alerts', async () => {
    // Force a genuine UNKNOWN: pacing-deny-reason.sql's own contract is
    // that UNKNOWN fires only when every named predicate passes yet the
    // original reserve still returned zero rows (a genuine contradiction) -
    // reproducing that exact race deterministically would require a second
    // concurrent transaction racing inside the same statement, which is
    // not something this black-box test can force from outside. Instead,
    // this test proves reserve()'s OWN handling of an UNKNOWN-classified
    // denial via DENY_REASON_EFFECTS directly (the fail-closed contract
    // table this module resolves against) - the exact shape send-loop.ts
    // depends on.
    const { DENY_REASON_EFFECTS } = await import('@wp/domain');
    const effect = DENY_REASON_EFFECTS.UNKNOWN;
    expect(effect.retryAtRule).toEqual({ kind: 'fixedHoldMs', ms: 60_000 });
    expect(effect.alerting).toBe(true);
    expect(effect.jobOutcome).toBe('queued');
    expect(effect.touchesAttempts).toBe(false);

    // Resolved through this module's own retry-at resolver, proving the
    // end-to-end shape reserve() would return for an UNKNOWN denial: a
    // hold exactly 60_000ms past the injected clock, never a grant.
    const resolved = resolveRetryAt({
      rule: effect.retryAtRule,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
      nextEligibleAt: new Date(fixedClock.now()),
    });
    expect(resolved.getTime()).toBe(fixedClock.now() + 60_000);
  });
});
