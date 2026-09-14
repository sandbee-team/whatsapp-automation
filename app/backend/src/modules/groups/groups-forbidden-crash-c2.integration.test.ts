import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import {
  resolveFailure,
  type ResolveFailureInput,
  type ResultDeps,
} from '../../engine/queue/result.js';
import { resolveTerminalFailure } from '../../engine/queue/result-terminal.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedWaGroup, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { seedGroupDispatchedAttempt } from './__tests__/forbidden-test-helpers.js';

/**
 * groups-forbidden-crash-c2.integration.test.ts (P24 C2 test-engineer) -
 * split out of `groups-forbidden-c2.integration.test.ts` at the max-lines
 * cap (topic split only, same fixture set): the crash-between-writes
 * atomicity proof for `resolveTerminalFailure`'s single-transaction
 * job-UPDATE + group-disable-UPDATE sequence.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-forbidden-crash-c2-test',
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

describe('group_forbidden - atomicity of the job UPDATE and the group-disable UPDATE', () => {
  it('a_thrown_error_from_the_group_disable_write_rolls_back_the_job_update_too_never_leaving_the_job_failed_while_the_group_stays_enabled', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
    });

    class SimulatedGroupDisableCrash extends Error {
      constructor() {
        super('simulated crash: the group-disable statement never returns');
        this.name = 'SimulatedGroupDisableCrash';
      }
    }

    // Wraps the REAL tenantDb so its single withTenant transaction (result.ts
    // opens exactly one for the FAIL_PERMANENT branch) runs on a tx whose
    // `.query` throws the moment it sees the group-disable statement's own
    // marker text (`disabled_reason = 'group_forbidden'`) - everything
    // BEFORE that point (the job UPDATE, the delivery_events write) runs for
    // real, on the SAME open Postgres transaction, so if the job UPDATE were
    // durable independently of this throw, it would still be visible after
    // rollback. It must not be.
    function crashInsideGroupDisable(real: TenantDb): TenantDb {
      return {
        async withTenant<T>(
          clientId2: string,
          fn: (tx: TenantQueryable) => Promise<T>,
        ): Promise<T> {
          return real.withTenant(clientId2, async (tx) => {
            const wrapped = {
              query: async (text: string, params?: unknown[]) => {
                if (
                  typeof text === 'string' &&
                  text.includes("disabled_reason = 'group_forbidden'")
                ) {
                  throw new SimulatedGroupDisableCrash();
                }
                return tx.query(text, params);
              },
            } as unknown as TenantQueryable;
            return fn(wrapped);
          });
        },
      };
    }

    const crashingDeps: ResultDeps = {
      tenantDb: crashInsideGroupDisable(tenantDb),
      rng: fixedRng,
    };

    await expect(
      resolveFailure(
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
          recipientJid: targetGroup.groupJid,
        } satisfies ResolveFailureInput,
        crashingDeps,
      ),
    ).rejects.toThrow(SimulatedGroupDisableCrash);

    // Job must NOT be 'failed' (the whole transaction rolled back) - it is
    // still 'processing' (resolveFailure's first, SEPARATE markAttempt
    // transaction already committed, but the job-status transaction did not).
    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).not.toBe('failed');

    // The group must still be enabled - the disable never committed.
    const groupRow = await pool.query<{ send_enabled: boolean }>(
      'SELECT send_enabled FROM wa_groups WHERE id = $1',
      [targetGroup.id],
    );
    expect(groupRow.rows[0]?.send_enabled).toBe(true);
  });

  it('resolveTerminalFailure_called_directly_with_an_injected_throw_never_partially_commits', async () => {
    // A second, narrower proof directly against `resolveTerminalFailure`
    // (no `resolveFailure`/`markAttempt` indirection): opens ONE real
    // transaction, injects the throw at the group-disable statement, and
    // asserts the job UPDATE from earlier in the SAME function call never
    // persisted either.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
    });

    class SimulatedGroupDisableCrash extends Error {}

    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        const wrapped = {
          query: async (text: string, params?: unknown[]) => {
            if (typeof text === 'string' && text.includes("disabled_reason = 'group_forbidden'")) {
              throw new SimulatedGroupDisableCrash();
            }
            return tx.query(text, params);
          },
        } as unknown as TenantQueryable;
        await resolveTerminalFailure(
          wrapped,
          {
            clientId,
            instanceId,
            jobId: seeded.jobId,
            jobCreatedAt: seeded.jobCreatedAt,
            leaseId: seeded.leaseId,
            attemptNo: seeded.attemptNo,
            publicId: seeded.publicId,
            errorClass: 'group_forbidden',
            recipientJid: targetGroup.groupJid,
          },
          {},
        );
      }),
    ).rejects.toThrow(SimulatedGroupDisableCrash);

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).not.toBe('failed');
    const groupRow = await pool.query<{ send_enabled: boolean }>(
      'SELECT send_enabled FROM wa_groups WHERE id = $1',
      [targetGroup.id],
    );
    expect(groupRow.rows[0]?.send_enabled).toBe(true);
  });
});
