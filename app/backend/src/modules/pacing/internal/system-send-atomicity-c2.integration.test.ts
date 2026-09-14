import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { sendOptOutConfirmation } from './system-send.js';

/**
 * system-send-atomicity-c2.integration.test.ts (P14 C2 review, crash-mid-
 * transaction lens) - `sendOptOutConfirmation`'s module doc asserts the
 * `optout_confirmations` 30-day guard UPSERT and the `message_jobs` enqueue
 * share ONE `withTenant` transaction, so "crash between the guard write and
 * the job enqueue" is impossible-by-tx. This is provable directly: force the
 * job enqueue half to fail (an invalid FK - a nonexistent `instanceId`,
 * which `message_jobs.instance_id REFERENCES whatsapp_instances(id)`
 * rejects) and assert the guard row's write ALSO never lands - proving both
 * statements really do share one transaction, not two independently-
 * committing ones.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'system-send-atomicity-c2',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM optout_confirmations WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('sendOptOutConfirmation transaction atomicity (P14 C2, real Postgres)', () => {
  it('a_forced_enqueue_failure_rolls_back_the_thirty_day_guard_upsert_too', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-system-send-atomicity-hash');
    const nonExistentInstanceId = randomUUID(); // no whatsapp_instances row - FK violation on enqueue

    await expect(
      sendOptOutConfirmation(
        { tenantDb },
        {
          clientId,
          instanceId: nonExistentInstanceId,
          phoneHash,
          e164: '+15550009876',
        },
      ),
    ).rejects.toThrow();

    // If the guard UPSERT and the enqueue were two independently-committing
    // transactions, the guard row would exist here (having committed before
    // the enqueue's own FK violation). Because they share ONE transaction,
    // the guard row must ALSO be gone - proving the atomicity claim, not
    // just asserting it from the doc comment.
    const guardRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM optout_confirmations
        WHERE client_id = $1 AND phone_hash = $2`,
      [clientId, phoneHash],
    );
    expect(Number(guardRow.rows[0]?.count)).toBe(0);

    // No message_jobs row either, obviously (the FK violation is what
    // caused the rollback in the first place) - confirms nothing was
    // partially applied.
    const jobRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND recipient_hash = $2`,
      [clientId, phoneHash],
    );
    expect(Number(jobRows.rows[0]?.count)).toBe(0);
  });

  it('a_genuinely_new_confirmation_commits_both_the_guard_row_and_the_job_together', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-system-send-atomicity-success-hash');

    const result = await sendOptOutConfirmation(
      { tenantDb },
      { clientId, instanceId, phoneHash, e164: '+15550001234' },
    );
    expect(result.enqueued).toBe(true);

    const guardRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM optout_confirmations
        WHERE client_id = $1 AND phone_hash = $2`,
      [clientId, phoneHash],
    );
    expect(Number(guardRow.rows[0]?.count)).toBe(1);

    const jobRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND recipient_hash = $2 AND send_origin = 'opt_out_confirmation'`,
      [clientId, phoneHash],
    );
    expect(Number(jobRows.rows[0]?.count)).toBe(1);
  });
});
