import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import { fetchLiveColumnGrantsForTables, fetchLiveGrantsForTables } from './helpers/grants.js';
import {
  connectAsWpApp,
  expectDenied,
  rollbackAndRelease,
  runDeliveryEventAndAudit,
  runReplayGuardAndAttemptWrite,
  seedJobWithAttempt,
} from './helpers/unresolved-grants-support.js';

/**
 * db/tests/unresolved-grants.test.ts (P12 Unit U5a) - proves migration 0028
 * against the REAL database, running every assertion under `SET ROLE
 * wp_app` (never the shared pool's own `wp` role) - the blind spot
 * `.memory/lessons/2026-09-01-bypassrls-test-role-hides-production-rls.md`
 * documents. Seeding, connection helpers, and the two write-sequence
 * runners that mirror `unresolved.service.ts`'s actual statements live in
 * the `helpers/unresolved-grants-support.ts` sibling (max-lines split, same
 * idiom as `session-worker-discovery-wiring.ts`); this file owns only the
 * `it(...)` cases.
 */
describe('unresolved_grants', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM unresolved_action_keys WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_app_can_mark_a_send_attempt_reconciled_lost', async () => {
    const pool = await getMigratedPool();
    const seed = await seedJobWithAttempt(probeClientIds);

    const client = await connectAsWpApp(pool, seed.clientId);
    try {
      const result = await client.query(
        `UPDATE send_attempts SET state = 'reconciled_lost', resolved_at = now()
          WHERE client_id = $1 AND message_job_id = $2 AND id = $3`,
        [seed.clientId, seed.jobId, seed.attemptId],
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('wp_app_can_execute_every_write_the_unresolved_retry_path_performs', async () => {
    const pool = await getMigratedPool();
    const seed = await seedJobWithAttempt(probeClientIds);

    const client = await connectAsWpApp(pool, seed.clientId);
    try {
      await runReplayGuardAndAttemptWrite(client, seed, 'retry');

      const jobResult = await client.query(
        `UPDATE message_jobs SET status = 'queued', next_attempt_at = now(),
                needs_user_action = false, unresolved_reason = NULL, unresolved_at = NULL
          WHERE id = $1 AND client_id = $2 AND status = 'blocked_needs_review'`,
        [seed.jobId, seed.clientId],
      );
      expect(jobResult.rowCount).toBe(1);

      await runDeliveryEventAndAudit(client, seed, 'queued');
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('wp_app_can_execute_every_write_the_unresolved_discard_path_performs', async () => {
    const pool = await getMigratedPool();
    const seed = await seedJobWithAttempt(probeClientIds);

    const client = await connectAsWpApp(pool, seed.clientId);
    try {
      await runReplayGuardAndAttemptWrite(client, seed, 'discard');

      const jobResult = await client.query(
        `UPDATE message_jobs SET status = 'cancelled', cancel_reason = 'unresolved_discarded', terminal_at = now(),
                needs_user_action = false, unresolved_reason = NULL, unresolved_at = NULL
          WHERE id = $1 AND client_id = $2 AND status = 'blocked_needs_review'`,
        [seed.jobId, seed.clientId],
      );
      expect(jobResult.rowCount).toBe(1);

      await runDeliveryEventAndAudit(client, seed, 'cancelled');
    } finally {
      await rollbackAndRelease(client);
    }
  });

  it('wp_app_still_cannot_delete_a_send_attempt_or_a_message_job', async () => {
    const pool = await getMigratedPool();
    const seed = await seedJobWithAttempt(probeClientIds);

    await expectDenied(
      pool,
      seed.clientId,
      `DELETE FROM send_attempts WHERE id = $1`,
      [seed.attemptId],
      '42501',
    );
    await expectDenied(
      pool,
      seed.clientId,
      `DELETE FROM message_jobs WHERE id = $1`,
      [seed.jobId],
      '42501',
    );
  });

  it('wp_app_cannot_update_a_send_attempt_column_outside_the_granted_list', async () => {
    const pool = await getMigratedPool();
    const seed = await seedJobWithAttempt(probeClientIds);

    await expectDenied(
      pool,
      seed.clientId,
      `UPDATE send_attempts SET provider_msg_id = 'x' WHERE id = $1`,
      [seed.attemptId],
      '42501',
    );
    await expectDenied(
      pool,
      seed.clientId,
      `UPDATE send_attempts SET content_hash = '\\x00'::bytea WHERE id = $1`,
      [seed.attemptId],
      '42501',
    );
  });

  it('wp_admin_app_gains_no_write_grant_on_send_attempts_or_message_jobs', async () => {
    const pool = await getMigratedPool();

    const tables = ['send_attempts', 'message_jobs'];
    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', tables);
    const columnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', tables);

    const writeTableGrants = tableGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );
    const writeColumnGrants = columnGrants.filter((row) =>
      ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type),
    );

    expect(writeTableGrants).toEqual([]);
    expect(writeColumnGrants).toEqual([]);

    const selectGrants = tableGrants.filter((row) => row.privilege_type === 'SELECT');
    expect(selectGrants.length).toBeGreaterThan(0);
  });
});
