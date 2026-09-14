import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * claim-and-reserve-ledger-date.integration.test.ts (P13 C1 review,
 * Finding 1 fix) - proves `message_jobs.pacing_ledger_date` is written back
 * from `reserve-pacing.sql`'s own authoritative RETURNING `ledger_date`
 * (the instance's LOCAL calendar date), never a Node-computed UTC date.
 *
 * `reserve-pacing.sql` computes `ledger_date` from the REAL server `now()`
 * (no injectable clock - same discipline `reserve-clock.integration.test.ts`
 * documents for itself), so this test reads the DB's own `now()` and
 * independently derives the expected Asia/Kolkata local date via `Intl`
 * (the fixture's `instance_pacing_state.pacing_timezone` DEFAULT, migration
 * 0030), rather than asserting a hardcoded date - deterministic because
 * both sides derive from the same real instant, never a wall-clock margin.
 * The formerly-buggy Node-derived `new Date(clock.now()).toISOString()
 * .slice(0, 10)` used the CLAIM's own injected clock and UTC, which is
 * exactly what this test proves is no longer read at all.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'claim-and-reserve-ledger-date-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

// Only used to satisfy claimAndReserve's Clock port (drawGapMs/pacing-deny
// resolution) - reserve-pacing.sql's own ledger_date computation ignores
// this entirely and always uses the real server now().
const claimClock = { now: () => Date.now() };

describe('claimAndReserve() writes back the reserve-authoritative local ledger_date', () => {
  it('pacing_ledger_date_on_the_job_always_equals_the_ledger_row_the_reserve_incremented', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, { clientId, instanceId });

    const tenantDb = createTenantDb(pool);
    const claimOneAndReserve = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });

    const before = await pool.query<{ now: Date }>('SELECT now() AS now');
    const claimed = await claimOneAndReserve(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'ledger-date-writeback-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed?.id).toBe(job.id);

    // The instance's LOCAL date (Asia/Kolkata, the fixture's default
    // pacing_timezone) for the real instant the reserve ran at - read back
    // from the DB's own now() (bracketing before/after the call), never a
    // client-side wall-clock guess. en-CA formats as YYYY-MM-DD.
    const dbNowMs = before.rows[0]!.now.getTime();
    const expectedLocalDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date(dbNowMs));

    const jobRow = await pool.query<{ pacing_ledger_date: string }>(
      'SELECT pacing_ledger_date::text FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobRow.rows[0]?.pacing_ledger_date).toBe(expectedLocalDate);

    // The EXACT ledger row the reserve incremented is the SAME date - the
    // job's own stored pacing_ledger_date must equal the ledger row that
    // was actually consumed, not merely "some plausible date".
    const ledgerRow = await pool.query<{ ledger_date: string; consumed_count: number }>(
      'SELECT ledger_date::text, consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledgerRow.rows).toEqual([{ ledger_date: expectedLocalDate, consumed_count: 1 }]);
  });
});
