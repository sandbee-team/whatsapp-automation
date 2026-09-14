import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimAndReserve } from '../queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from '../queue/__tests__/queue-send-test-helpers.js';

/**
 * claim-and-reserve-cold-outreach.integration.test.ts (P13 correctness fix,
 * post-close-review) - proves the WIRED path, `send-loop-pacing-claim.ts#
 * claimAndReserve` (the same function `send-loop-worker-wiring.ts` wires
 * into the real send loop), threads a claimed job's own stored
 * `message_jobs.is_new_conversation` classification into
 * `pacing_ledger.new_conv_count`, instead of the hardcoded `false` this file
 * exists to catch a regression back to.
 *
 * Split from `reserve-concurrency.integration.test.ts` (own file, not a
 * shared describe block) rather than appended there: `reserve-concurrency`
 * already sits at 193 lines proving `reserve-pacing.sql`'s OWN atomicity by
 * calling `reserve()` directly - the sibling-module split idiom
 * (`session-worker-discovery-wiring.ts` / `session-cost-feedback-timer.ts`)
 * applies here because this suite needs a DIFFERENT fixture entirely
 * (`seedSendTenant`/`seedQueuedJob` - the full claim-eligible tenant shape:
 * wallet, lease state, health) instead of `seedPacingInstance`'s narrower
 * pacing-only shape, and appending it would have pushed the file to 334
 * lines, over the 300-line cap.
 *
 * `new_conversation_cap_and_cold_ratio_are_atomic` (in the sibling file)
 * proves the SQL is atomic by calling `reserve()` directly with
 * `isNewConversation: true`, bypassing `claimAndReserve()` entirely -
 * nothing there proves the wired path ever passes a real (non-hardcoded)
 * value. These three cases close that gap by going through
 * `claimAndReserve()` itself.
 *
 * Clock is injected (`claimClock`), never wall-clock - no ambient-state
 * assertion anywhere in this file.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'claim-and-reserve-cold-outreach-tests',
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

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

function makeClaimAndReserve() {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({
    tenantDb,
    rng: { random: () => 0.5 },
    clock: claimClock,
  });
}

describe("claimAndReserve() wires the claimed job's real cold-outreach classification into the ledger", () => {
  it('claimed_job_cold_outreach_classification_reaches_the_ledger', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, {
      clientId,
      instanceId,
      isNewConversation: true,
    });

    const claimOneAndReserve = makeClaimAndReserve();
    const claimed = await claimOneAndReserve(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'cold-outreach-classification-test-worker',
        claimExpiryMs: 90_000,
      },
    );

    expect(claimed?.id).toBe(job.id);

    const ledger = await pool.query<{ new_conv_count: number; consumed_count: number }>(
      'SELECT new_conv_count, consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.new_conv_count).toBe(1);
    expect(ledger.rows[0]?.consumed_count).toBe(1);
  });

  it('a_warm_claimed_job_leaves_new_conv_count_byte_identical', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, {
      clientId,
      instanceId,
      isNewConversation: false,
    });

    const claimOneAndReserve = makeClaimAndReserve();
    const claimed = await claimOneAndReserve(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'cold-outreach-classification-test-worker',
        claimExpiryMs: 90_000,
      },
    );

    expect(claimed?.id).toBe(job.id);

    const ledger = await pool.query<{ new_conv_count: number; consumed_count: number }>(
      'SELECT new_conv_count, consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.new_conv_count).toBe(0);
    expect(ledger.rows[0]?.consumed_count).toBe(1);
  });

  it('a_new_conversation_group_job_never_counts_as_a_cold_dm', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, {
      clientId,
      instanceId,
      isNewConversation: true,
      recipientJid: `${randomUUID().replaceAll('-', '')}@g.us`,
    });

    const claimOneAndReserve = makeClaimAndReserve();
    const claimed = await claimOneAndReserve(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'cold-outreach-classification-test-worker',
        claimExpiryMs: 90_000,
      },
    );

    expect(claimed?.id).toBe(job.id);

    const ledger = await pool.query<{
      new_conv_count: number;
      consumed_count: number;
      group_sent_count: number;
    }>(
      'SELECT new_conv_count, consumed_count, group_sent_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    // The group rule (reserve-pacing.sql point 5, cited in
    // send-loop-pacing-claim.ts): a group send is never a cold DM, so
    // new_conv_count stays byte-identical at 0 even though the job's own
    // stored is_new_conversation is true - while consumed_count/
    // group_sent_count still increment, proving the job WAS claimed and
    // reserved, not merely denied for an unrelated reason.
    expect(ledger.rows[0]?.new_conv_count).toBe(0);
    expect(ledger.rows[0]?.consumed_count).toBe(1);
    expect(ledger.rows[0]?.group_sent_count).toBe(1);
  });
});
