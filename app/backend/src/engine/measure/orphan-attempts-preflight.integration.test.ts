import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../pacing/__tests__/pacing-test-helpers.js';
import {
  assertNoOrphanAttemptLandmines,
  OrphanAttemptLandmineError,
  readOrphanAttemptLandmines,
} from './orphan-attempts-preflight.js';

/**
 * orphan-attempts-preflight.integration.test.ts (FIX-P26-D) - real PG. Seeds
 * one probe client/instance via the existing pacing fixture, inserts orphan
 * `send_attempts` rows at controlled offsets from the live
 * `message_jobs_id_seq`, and asserts EXACT counts (never a bound - see
 * .claude/rules/core-invariants.md). The budget window (<= 1000) is chosen
 * so pre-existing orphan rows in this shared dev DB cannot fall inside it:
 * the nearest pre-existing orphan sits ~7.37M ids above the sequence
 * (verified manually before writing this test), far outside any window
 * used here.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'orphan-attempts-preflight-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function insertOrphanAttempt(
  clientId: string,
  instanceId: string,
  messageJobId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO send_attempts (client_id, instance_id, message_job_id, message_job_created_at, attempt_no, state, dispatched_at)
     VALUES ($1, $2, $3, now(), 1, 'acked', now())`,
    [clientId, instanceId, messageJobId],
  );
}

describe('orphan-attempts-preflight (real Postgres)', () => {
  it('throws OrphanAttemptLandmineError with the exact orphan count inside the budget', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds);
    const seqRow = await pool.query<{ last_value: string }>(
      'SELECT last_value FROM message_jobs_id_seq',
    );
    const seqLastValue = Number(seqRow.rows[0]?.last_value);

    await insertOrphanAttempt(clientId, instanceId, seqLastValue + 5);

    const error = await assertNoOrphanAttemptLandmines(pool, 1000).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OrphanAttemptLandmineError);
    expect((error as OrphanAttemptLandmineError).message).toContain('1');
  });

  it('reports the exact landmine reading fields for one orphan inside budget', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds);
    const seqRow = await pool.query<{ last_value: string }>(
      'SELECT last_value FROM message_jobs_id_seq',
    );
    const seqLastValue = Number(seqRow.rows[0]?.last_value);
    const jobId = seqLastValue + 5;

    await insertOrphanAttempt(clientId, instanceId, jobId);

    const landmines = await readOrphanAttemptLandmines(pool, 1000);
    expect(landmines.seqLastValue).toBe(seqLastValue);
    expect(landmines.idBudget).toBe(1000);
    expect(landmines.count).toBe(1);
    expect(landmines.minJobId).toBe(jobId);
    expect(landmines.maxJobId).toBe(jobId);
    expect(landmines.distinctClients).toBe(1);
  });

  it('ignores an orphan far outside the budget window', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds);
    const seqRow = await pool.query<{ last_value: string }>(
      'SELECT last_value FROM message_jobs_id_seq',
    );
    const seqLastValue = Number(seqRow.rows[0]?.last_value);

    await insertOrphanAttempt(clientId, instanceId, seqLastValue + 5000);

    const landmines = await assertNoOrphanAttemptLandmines(pool, 1000);
    expect(landmines.count).toBe(0);
    expect(landmines.minJobId).toBeNull();
    expect(landmines.maxJobId).toBeNull();
    expect(landmines.distinctClients).toBe(0);
  });

  it('does not count a send_attempts row whose message_job_id has a real message_jobs row', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds);
    const jobResult = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 3, 'queued', now(), now())
       RETURNING id`,
      [
        clientId,
        instanceId,
        `${crypto.randomUUID()}@s.whatsapp.net`,
        JSON.stringify({ text: 'x' }),
      ],
    );
    const jobId = jobResult.rows[0]?.id;
    if (jobId === undefined) throw new Error('setup: message_jobs insert returned no row');

    await insertOrphanAttempt(clientId, instanceId, Number(jobId));

    const landmines = await assertNoOrphanAttemptLandmines(pool, 1000);
    expect(landmines.count).toBe(0);
  });
});
