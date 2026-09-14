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
 * optout-confirmation-exact-thirty-day-boundary.integration.test.ts (P14 E3
 * edge pass) - pins the EXACT boundary semantics of `system-send.ts`'s
 * `ON CONFLICT ... DO UPDATE ... WHERE last_sent_at < now() - interval
 * '30 days'`: a `last_sent_at` of EXACTLY 30 days ago fails the strict `<`
 * comparison (`now() - interval '30 days' > last_sent_at` is false when
 * they are equal), so the guard is NOT yet eligible - `sendOptOutConfirmation`
 * must still skip (`enqueued: false`). This is the deliberately strict
 * reading the phase task calls out as the boundary to verify against the
 * SQL, distinct from `optout-confirmation-thirty-day-guard.integration.
 * test.ts`'s 31-day (clearly-past-window) case.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-confirmation-exact-boundary-test',
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

describe('sendOptOutConfirmation exact 30-day boundary (P14 E3, real Postgres)', () => {
  it('a_last_sent_at_of_exactly_thirty_days_ago_is_not_yet_eligible', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('exact-thirty-day-boundary-fixture');
    const tenantDb = createTenantDb(pool);

    const first = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550006666' },
    );
    expect(first.enqueued).toBe(true);

    // Set last_sent_at to EXACTLY now() - 30 days, computed in the same
    // statement so there is no clock-skew gap between the UPDATE's own
    // now() and the guard's later now() at the moment sendOptOutConfirmation
    // re-evaluates - both read from the same real Postgres clock.
    await pool.query(
      `UPDATE optout_confirmations SET last_sent_at = now() - interval '30 days'
        WHERE client_id = $1 AND phone_hash = $2`,
      [clientId, phoneHash],
    );

    const second = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550006666' },
    );
    // Exactly 30 days ago fails the strict `<` comparison - still skipped.
    expect(second.enqueued).toBe(false);

    const jobCount = await pool.query(
      `SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1 AND send_origin = 'opt_out_confirmation'`,
      [clientId],
    );
    expect(jobCount.rows[0]?.n).toBe(1);
  });
});
