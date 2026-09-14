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
 * reserve-clock-refund.integration.test.ts (P13 C1 review, Finding 8 fix) -
 * split out of `reserve-clock.integration.test.ts` purely for that file's
 * max-lines cap (same split idiom as `deferral-release-and-unknown.
 * integration.test.ts`). The mandatory named test
 * `refund_after_local_midnight_hits_the_right_day` from the phase file's
 * "Tests that prove it" table, missing entirely before this fix.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-clock-refund-tests',
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

const fixedClock = { now: () => Date.now() };

describe('release() after local midnight hits the right day', () => {
  /**
   * `reserve-pacing.sql` uses REAL `now()` (no injectable clock), so
   * "advance past local midnight" is simulated by seeding a SECOND
   * `pacing_ledger` row for TOMORROW (day N+1) alongside the real row
   * `reserve()` writes for TODAY (day N) - `release()`'s `$ledger_date`
   * bind targets day N specifically (the job's own stored
   * `pacing_ledger_date`), proving it decrements ONLY day N, never N+1.
   */
  it('refund_after_local_midnight_hits_the_right_day', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 10,
    });
    const jobId = await seedPacingMessageJob(pool, { clientId, instanceId });

    // Day N: a genuine reserve, using the real DB now() (Asia/Kolkata).
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
    const dayN = outcome.ledgerDate;

    // Day N+1: seed a SEPARATE pacing_ledger row for tomorrow's date, with
    // its own non-zero consumed_count - simulating "the local day has
    // since rolled over and day N+1 has already seen sends of its own".
    const dayNPlus1 = await pool.query<{ tomorrow: string }>(
      `SELECT ($1::date + interval '1 day')::date::text AS tomorrow`,
      [dayN],
    );
    const tomorrow = dayNPlus1.rows[0]!.tomorrow;
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, hour_key, consumed_count, next_eligible_at)
       VALUES ($1, $2, $3::date, 0, 5, now())`,
      [clientId, instanceId, tomorrow],
    );

    // Refund using the job's OWN stored ledger_date (day N) - never "today"
    // as of the refund call, never re-derived.
    const refundOutcome = await release({
      sql: pool,
      clientId,
      instanceId,
      ledgerDate: dayN,
      messageJobId: jobId,
      isNewConversation: false,
      isGroup: false,
      isExempt: false,
      gapMs: 0,
    });
    expect(refundOutcome.refunded).toBe(true);

    const rows = await pool.query<{ ledger_date: string; consumed_count: number }>(
      'SELECT ledger_date::text, consumed_count FROM pacing_ledger WHERE instance_id = $1 ORDER BY ledger_date',
      [instanceId],
    );
    const dayNRow = rows.rows.find((r) => r.ledger_date === dayN);
    const dayNPlus1Row = rows.rows.find((r) => r.ledger_date === tomorrow);

    // Day N's row was decremented (the refund's own target).
    expect(dayNRow?.consumed_count).toBe(0);
    // Day N+1's row was NEVER touched - still exactly its seeded value.
    expect(dayNPlus1Row?.consumed_count).toBe(5);
  });
});
