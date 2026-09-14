import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { sendOptOutConfirmation } from '../internal/system-send.js';

/**
 * optout-confirmation-thirty-day-guard.integration.test.ts (P14 Unit U4,
 * step 7) - split out of `registry-optout-enforcement.integration.test.ts`
 * purely for that file's max-lines cap (same established split idiom used
 * throughout this phase). Proves `sendOptOutConfirmation`'s 30-day guard:
 * two calls within the window enqueue exactly ONE confirmation job; once
 * `last_sent_at` is pushed back past 30 days, a third call enqueues again.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-confirmation-guard-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM optout_confirmations WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('sendOptOutConfirmation 30-day guard (P14 Unit U4, real Postgres)', () => {
  it('duplicate_stop_sends_one_confirmation_within_thirty_days', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('duplicate-stop-phone-hash-fixture');
    const tenantDb = createTenantDb(pool);

    const first = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550005555' },
    );
    expect(first.enqueued).toBe(true);

    const second = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550005555' },
    );
    expect(second.enqueued).toBe(false);

    const jobsAfterTwoCalls = await pool.query(
      `SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1 AND send_origin = 'opt_out_confirmation'`,
      [clientId],
    );
    expect(jobsAfterTwoCalls.rows[0]?.n).toBe(1);

    // Push last_sent_at back 31 days - the guard's own WHERE now matches.
    await pool.query(
      `UPDATE optout_confirmations SET last_sent_at = now() - interval '31 days'
        WHERE client_id = $1 AND phone_hash = $2`,
      [clientId, phoneHash],
    );
    // confirmationIdempotencyKey is scoped to THIS local calendar day (its
    // own doc comment) - a real 31-days-later call lands on a different
    // day and mints a fresh key naturally. This test runs all three calls
    // within the same wall-clock day, so it must simulate that day
    // boundary itself: delete the first call's ref row for this exact key
    // (never touching the message_jobs row it points at) so the third
    // call's INSERT ... ON CONFLICT has nothing to replay against.
    await pool.query(
      `DELETE FROM message_job_refs WHERE client_id = $1 AND idempotency_key LIKE $2`,
      [clientId, `optout-confirm:${phoneHash.toString('hex')}:%`],
    );

    const third = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550005555' },
    );
    expect(third.enqueued).toBe(true);

    const jobsAfterThreeCalls = await pool.query(
      `SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1 AND send_origin = 'opt_out_confirmation'`,
      [clientId],
    );
    expect(jobsAfterThreeCalls.rows[0]?.n).toBe(2);
  });
});
