import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { classifySendError } from '../../provider/baileys/error-map.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  resolveAck,
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
import {
  seedGroupDispatchedAttempt,
  seedDmDispatchedAttempt,
} from './__tests__/forbidden-test-helpers.js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * forbidden-edge.integration.test.ts (P24 Unit U4b, step 7) - split out of
 * `forbidden.integration.test.ts` at the max-lines cap (topic split only,
 * same fixture set): the sibling-group isolation + dedupe case, the DM-
 * still-pauses regression proof, and the structural health-writers scan.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-forbidden-edge-test',
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

describe('resolveFailure - group_forbidden edge cases (real Postgres)', () => {
  it('a_group_forbidden_error_disables_only_that_group', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const siblingGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
    });

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const firstFailure: ResolveFailureInput = {
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
      recipientJid: targetGroup.groupJid,
    };
    await resolveFailure(firstFailure, deps);

    const targetRow = await pool.query<{
      send_enabled: boolean;
      disabled_reason: string | null;
      next_sync_after: Date | null;
    }>('SELECT send_enabled, disabled_reason, next_sync_after FROM wa_groups WHERE id = $1', [
      targetGroup.id,
    ]);
    expect(targetRow.rows[0]?.send_enabled).toBe(false);
    expect(targetRow.rows[0]?.disabled_reason).toBe('group_forbidden');
    expect(targetRow.rows[0]?.next_sync_after).not.toBeNull();

    const auditRows = await pool.query<{ target_id: string }>(
      `SELECT target_id FROM audit_logs
        WHERE client_id = $1 AND action = 'group.send_disabled'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]?.target_id).toBe(targetGroup.id);

    const notificationRowsFirst = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(notificationRowsFirst.rows).toHaveLength(1);

    // A SECOND forbidden on the SAME group before re-enable - deduped, still
    // exactly one notification row.
    const seededSecond = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
      attempts: 0,
    });
    await resolveFailure(
      {
        ...firstFailure,
        jobId: seededSecond.jobId,
        jobCreatedAt: seededSecond.jobCreatedAt,
        leaseId: seededSecond.leaseId,
        attemptNo: seededSecond.attemptNo,
        publicId: seededSecond.publicId,
      },
      deps,
    );
    const notificationRowsSecond = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(notificationRowsSecond.rows).toHaveLength(1);

    // The SIBLING group is byte-identical, and still sendable.
    const siblingRow = await pool.query<{ send_enabled: boolean; disabled_reason: string | null }>(
      'SELECT send_enabled, disabled_reason FROM wa_groups WHERE id = $1',
      [siblingGroup.id],
    );
    expect(siblingRow.rows[0]?.send_enabled).toBe(true);
    expect(siblingRow.rows[0]?.disabled_reason).toBeNull();

    const siblingSend = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: siblingGroup.groupJid,
    });
    await resolveAck(
      {
        clientId,
        instanceId,
        jobId: siblingSend.jobId,
        jobCreatedAt: siblingSend.jobCreatedAt,
        leaseId: siblingSend.leaseId,
        attemptNo: siblingSend.attemptNo,
        publicId: siblingSend.publicId,
        outcome: { providerMsgId: 'wamid.sibling-1' },
        payloadKind: 'text',
        recipientJid: siblingGroup.groupJid,
      },
      deps,
    );
    const siblingJobRow = await getJobResultRow(pool, siblingSend.jobId);
    expect(siblingJobRow.status).toBe('sent');
  });

  it('a_403_on_a_dm_target_still_pauses_the_instance', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const dm = await seedDmDispatchedAttempt(pool, clientId, instanceId);

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    await resolveFailure(
      {
        clientId,
        instanceId,
        jobId: dm.jobId,
        jobCreatedAt: dm.jobCreatedAt,
        leaseId: dm.leaseId,
        attemptNo: 1,
        publicId: dm.publicId,
        attempts: 1,
        maxAttempts: 5,
        error: new TransportSendError('restricted', 'blocked'),
        recipientJid: dm.recipientJid,
      },
      deps,
    );

    const instanceRow = await pool.query<{ health_state: string; pause_reason: string }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.health_state).toBe('paused');
    expect(instanceRow.rows[0]?.pause_reason).toBe('provider_restriction');

    const dmClassified = classifySendError(new Error('not-admin: forbidden') as never, {
      recipientJid: '15550001111@s.whatsapp.net',
    });
    expect(dmClassified.sendErrorClass).toBe('unknown');

    const boom403 = { output: { statusCode: 403 }, message: 'not-admin: forbidden' };
    const dmResult = classifySendError(boom403, { recipientJid: '15550001111@s.whatsapp.net' });
    expect(dmResult.sendErrorClass).toBe('restricted');
    const groupResult = classifySendError(boom403, { recipientJid: '120363111@g.us' });
    expect(groupResult.sendErrorClass).toBe('group_forbidden');
  });

  it('the_forbidden_hook_never_touches_health_state', () => {
    const filesToScan = [
      path.resolve(__dirname, 'on-forbidden.ts'),
      path.resolve(__dirname, '..', '..', 'engine', 'queue', 'result-terminal.ts'),
      path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'db',
        'queries',
        'group-disable-on-forbidden.sql',
      ),
    ];
    const forbiddenStrings = ['health_state', 'pause_reason', 'hard_signal', 'pacing_events'];
    for (const filePath of filesToScan) {
      const content = readFileSync(filePath, 'utf8');
      for (const needle of forbiddenStrings) {
        expect(content.includes(needle), `${filePath} unexpectedly contains "${needle}"`).toBe(
          false,
        );
      }
    }

    // Shells out to the CLI (never a direct import): `scripts/` is a
    // standalone `tsc -b` project with no edge onto `app/backend` - importing
    // `runCheckHealthWriters` broke `tsc -b`'s file-list boundary even though
    // vitest resolved it fine. Same `execFileSync` idiom `enqueue.api-
    // boundary.integration.test.ts` uses for `depcruise`.
    const repoRoot = path.resolve(
      fileURLToPath(import.meta.url),
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
    );
    const output = execFileSync('pnpm', ['exec', 'tsx', 'scripts/check-health-writers.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    expect(output).toMatch(/0 violations/);
    expect(output).toMatch(/check-health-writers: \d+ files scanned/);
  });
});
