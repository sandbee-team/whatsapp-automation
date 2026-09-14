import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import {
  resolveFailure,
  type ResolveFailureInput,
  type ResultDeps,
} from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedWaGroup, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { seedGroupDispatchedAttempt } from './__tests__/forbidden-test-helpers.js';

/**
 * groups-forbidden-c2.integration.test.ts (P24 C2 test-engineer) - the
 * `group_forbidden` hook edge cases beyond `forbidden.integration.test.ts`/
 * `forbidden-edge.integration.test.ts`'s own coverage: a forbidden result
 * for a group NEVER synced (no `wa_groups` row), two forbidden results in
 * quick succession on the SAME never-synced group jid, and a forbidden
 * result arriving AFTER a tenant re-enables the group (the dedupe-key-
 * forever question the C2 task flags). The crash-injected atomicity proof
 * (job UPDATE + group-disable UPDATE, same transaction) lives in the
 * sibling `groups-forbidden-crash-c2.integration.test.ts` (max-lines split).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-forbidden-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group_forbidden - never synced group', () => {
  it('a_forbidden_result_for_a_group_never_synced_is_still_terminal_with_no_throw_and_no_notification', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const neverSyncedGroupJid = '120363800000000001@g.us';
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: neverSyncedGroupJid,
    });

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const failureInput: ResolveFailureInput = {
      clientId,
      instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      attempts: 1,
      maxAttempts: 5,
      error: new TransportSendError('group_forbidden', 'not-participant'),
      recipientJid: neverSyncedGroupJid,
    };

    await expect(resolveFailure(failureInput, deps)).resolves.toBeUndefined();

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('failed');
    expect(jobRow.last_error_class).toBe('group_forbidden');

    const notificationRows = await pool.query(
      `SELECT 1 FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(notificationRows.rows).toHaveLength(0);

    const auditRows = await pool.query(
      `SELECT 1 FROM audit_logs WHERE client_id = $1 AND action = 'group.send_disabled'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(0);

    const groupRows = await pool.query(
      `SELECT 1 FROM wa_groups WHERE client_id = $1 AND instance_id = $2 AND group_jid = $3`,
      [clientId, instanceId, neverSyncedGroupJid],
    );
    expect(groupRows.rows).toHaveLength(0);
  });

  it('two_forbidden_results_in_one_second_on_the_same_never_synced_group_are_both_terminal_no_notification_either_time', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const neverSyncedGroupJid = '120363800000000002@g.us';
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    for (let i = 0; i < 2; i += 1) {
      const seeded = await seedGroupDispatchedAttempt(pool, {
        clientId,
        instanceId,
        groupJid: neverSyncedGroupJid,
        attempts: 0,
      });
      await resolveFailure(
        {
          clientId,
          instanceId,
          jobId: seeded.jobId,
          jobCreatedAt: seeded.jobCreatedAt,
          leaseId: seeded.leaseId,
          attemptNo: seeded.attemptNo,
          publicId: seeded.publicId,
          attempts: 1,
          maxAttempts: 5,
          error: new TransportSendError('group_forbidden', 'not-participant'),
          recipientJid: neverSyncedGroupJid,
        },
        deps,
      );
    }

    const notificationRows = await pool.query(
      `SELECT 1 FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(notificationRows.rows).toHaveLength(0);
  });
});

describe('group_forbidden - dedupe key includes the enable cycle (FIXED)', () => {
  it('a_forbidden_after_the_tenant_re_enables_the_group_disables_it_again_and_writes_a_new_notification_FLAG', async () => {
    // FIXED (P24 C2 fix round, Fix 6): `notify()`'s dedupe key now folds in
    // the group's `send_enabled_at` (read BEFORE the disable, as
    // `bucket`) - a group that is forbidden, re-enabled by the tenant (a
    // fresh `send_enabled_at`), and forbidden AGAIN gets a DIFFERENT
    // dedupe key from the first event, so the tenant is notified again.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const firstSeeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
    });
    await resolveFailure(
      {
        clientId,
        instanceId,
        jobId: firstSeeded.jobId,
        jobCreatedAt: firstSeeded.jobCreatedAt,
        leaseId: firstSeeded.leaseId,
        attemptNo: firstSeeded.attemptNo,
        publicId: firstSeeded.publicId,
        attempts: 1,
        maxAttempts: 5,
        error: new TransportSendError('group_forbidden', 'not-participant'),
        recipientJid: targetGroup.groupJid,
      },
      deps,
    );

    const firstNotifications = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(firstNotifications.rows).toHaveLength(1);

    // Tenant re-enables the group (a real UPDATE, mirroring the route's own
    // `groups-set-send-enabled.sql`, which also bumps `send_enabled_at` on
    // every enable - a NEW enable cycle needs a NEW epoch to be
    // distinguishable from the first one above).
    await pool.query(
      `UPDATE wa_groups SET send_enabled = true, disabled_reason = NULL, send_enabled_at = now()
        WHERE id = $1`,
      [targetGroup.id],
    );

    const secondSeeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
      attempts: 0,
    });
    await resolveFailure(
      {
        clientId,
        instanceId,
        jobId: secondSeeded.jobId,
        jobCreatedAt: secondSeeded.jobCreatedAt,
        leaseId: secondSeeded.leaseId,
        attemptNo: secondSeeded.attemptNo,
        publicId: secondSeeded.publicId,
        attempts: 1,
        maxAttempts: 5,
        error: new TransportSendError('group_forbidden', 'not-participant'),
        recipientJid: targetGroup.groupJid,
      },
      deps,
    );

    // The group IS disabled again (not deduped - a plain conditional UPDATE).
    const groupRow = await pool.query<{ send_enabled: boolean; disabled_reason: string | null }>(
      'SELECT send_enabled, disabled_reason FROM wa_groups WHERE id = $1',
      [targetGroup.id],
    );
    expect(groupRow.rows[0]?.send_enabled).toBe(false);
    expect(groupRow.rows[0]?.disabled_reason).toBe('group_forbidden');

    // A NEW notification was written - the dedupe key's bucket (the group's
    // `send_enabled_at`, read before this disable) differs from the first
    // event's bucket because a full enable/disable cycle happened between
    // them: exactly 2 notifications total across the two cycles.
    const secondNotifications = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(secondNotifications.rows).toHaveLength(2);
  });
});
