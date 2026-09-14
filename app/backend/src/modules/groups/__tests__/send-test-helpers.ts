import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createPool, createTenantDb } from '@wp/db';
import { FileKeyProvider, type KeyProvider } from '@wp/server-kit/crypto';
import { createFakeTransport } from '../../../provider/__test-support__/fake-transport.js';
import { runOneSendLoopIteration, type SendLoopDeps } from '../../../engine/queue/send-loop.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { dispatch } from '../../../engine/queue/dispatch.js';
import { resolveAck, resolveFailure } from '../../../engine/queue/result.js';
import { bindQueueMetrics } from '../../../engine/queue/metrics.js';
import type { ObjectStore } from '../../../platform/storage/object-store-types.js';
import { createMessage } from '../../messages/messages.service.js';

type TestPool = ReturnType<typeof createPool>;
type TestTenantDb = ReturnType<typeof createTenantDb>;

/**
 * modules/groups/__tests__/send-test-helpers.ts (P24 groups-messaging, Unit
 * U4a, step 6) - shared, non-test fixture machinery for the group send-path
 * integration suites (`send.integration.test.ts` / `send-guards.integration.
 * test.ts`, split at the max-lines cap - same established idiom as
 * `pipeline.integration.test.ts` / `pipeline-disposal-loop.integration.
 * test.ts`). Lives under `__tests__/` (never `groups-test-helpers.ts`,
 * which is a pre-created shared file this unit does not own) so the
 * tenant-scope guard's seed/cleanup exemption covers its raw queries.
 */

/**
 * A minimal, self-contained `optout-pepper` key provider - deliberately NOT
 * `modules/messages/enqueue-test-support.ts#buildTestKeyProvider` (that
 * file imports `platform/http/server.ts#buildApp`, which wires the WHOLE
 * production app including `registerGroupsRoutes` from U3's
 * `modules/groups/index.ts` barrel - a needless coupling to another unit's
 * in-progress files this suite has no reason to depend on; `createMessage`
 * is called directly here, never through HTTP).
 */
export function buildGroupSendTestKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-groups-send-optout-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0d).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return new FileKeyProvider({ ringPath: path, mountedPurposes: ['optout-pepper'] });
}

/** `seedSendTenant` never sets `link_state` (stays at its `'unlinked'` DEFAULT) - the enqueue service's own link-state gate needs `'linked'`. */
export async function linkInstance(pool: TestPool, instanceId: string): Promise<void> {
  await pool.query(`UPDATE whatsapp_instances SET link_state = 'linked' WHERE id = $1`, [
    instanceId,
  ]);
}

export interface EnqueueViaOptions {
  payload?: Record<string, unknown>;
  payloadKind?: string;
}

/**
 * Enqueues one message via the REAL `createMessage` service - never a
 * hand-inserted job row (the enqueue branch itself is what mandatory tests
 * 7/8 exercise). A DM (non-`@g.us`) jid gets a synthetic E.164
 * (`mj_recipient_shape` requires one; a group recipient never has one).
 */
export async function enqueueVia(
  tenantDb: TestTenantDb,
  keyProvider: KeyProvider,
  clientId: string,
  instanceId: string,
  recipientJid: string,
  options: EnqueueViaOptions = {},
): Promise<{ id: string }> {
  const isGroup = recipientJid.endsWith('@g.us');
  return createMessage(
    tenantDb,
    {
      clientId,
      instanceId,
      idempotencyKey: randomUUID(),
      requestBody: { recipient: recipientJid },
      recipient: { jid: recipientJid, e164: isGroup ? null : '+15550001234' },
      payload: options.payload ?? { text: 'hello group' },
      payloadKind: options.payloadKind ?? 'text',
      priority: 'normal',
      scheduledAt: null,
      sendOrigin: 'api_send',
    },
    { keyProvider },
  );
}

export async function jobIdForPublicId(
  pool: TestPool,
  clientId: string,
  publicId: string,
): Promise<string> {
  const result = await pool.query<{ message_job_id: string }>(
    `SELECT message_job_id FROM message_job_refs WHERE client_id = $1 AND public_id = $2`,
    [clientId, publicId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobIdForPublicId: no ref row for public_id ${publicId}`);
  return row.message_job_id;
}

export interface LedgerRow {
  consumed_count: number;
  group_sent_count: number;
  new_conv_count: number;
}

export async function ledgerFor(pool: TestPool, instanceId: string): Promise<LedgerRow> {
  const result = await pool.query<LedgerRow>(
    `SELECT consumed_count, group_sent_count, new_conv_count FROM pacing_ledger WHERE instance_id = $1`,
    [instanceId],
  );
  return result.rows[0] ?? { consumed_count: 0, group_sent_count: 0, new_conv_count: 0 };
}

export interface JobStateRow {
  status: string;
  attempts: number;
  pacing_deny_reason: string | null;
  next_attempt_at: Date;
  is_new_conversation: boolean;
}

export async function jobState(pool: TestPool, jobId: string): Promise<JobStateRow> {
  const result = await pool.query<JobStateRow>(
    `SELECT status, attempts, pacing_deny_reason, next_attempt_at, is_new_conversation
       FROM message_jobs WHERE id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobState: no message_jobs row with id ${jobId}`);
  return row;
}

export interface RunSendLoopOptions {
  clientId: string;
  instanceId: string;
  fence?: number;
  transport?: ReturnType<typeof createFakeTransport>;
  clockMs?: number;
  /** P34 (2026-09-14): required for a `payloadKind: 'media'` job - `dispatch()` resolves the asset bytes through this store BEFORE the precheck transaction, and a missing store is itself a DEFER (`no_object_store_configured`), never a send. Text-only callers leave it unset. */
  objectStore?: ObjectStore;
}

/** Runs exactly ONE send-loop iteration through the REAL claim -> reserve -> dispatch -> resolveAck/resolveFailure chain, over a frozen clock. Returns whether a job was claimed. */
export async function runOneIteration(
  tenantDb: TestTenantDb,
  pool: TestPool,
  options: RunSendLoopOptions,
): Promise<boolean> {
  const clock = { now: () => options.clockMs ?? Date.UTC(2026, 8, 6, 10, 0, 0) };
  const rng = { random: () => 0.5 };
  const metrics = bindQueueMetrics();
  const claimAndReserveFn = claimAndReserve({ tenantDb, rng, clock });
  const deps: SendLoopDeps = {
    clientId: options.clientId,
    instanceId: options.instanceId,
    workerId: 'groups-send-test-worker',
    fence: options.fence ?? 1,
    claimOne: claimAndReserveFn,
    dispatch: (input, d) => dispatch(input, d as never),
    resolveAck: (input, d) => resolveAck(input, d as never),
    resolveFailure: (input, d) => resolveFailure(input, d as never),
    readMaxAttempts: async () => 5,
    metrics,
    rng,
    clock,
    ctx: { clientId: options.clientId, sql: pool },
    dispatchDeps: {
      tenantDb,
      transport: options.transport,
      clock,
      objectStore: options.objectStore,
    },
    resultDeps: { tenantDb, rng },
  };
  const result = await runOneSendLoopIteration(deps);
  return result.claimed;
}

/** Resets the pacing min-gap so the NEXT `runOneIteration` call is immediately eligible again - same idiom as `expansion-drain-full-c1fix.integration.test.ts`. */
export async function resetMinGap(pool: TestPool, instanceId: string): Promise<void> {
  await pool.query(`UPDATE pacing_ledger SET next_eligible_at = now() WHERE instance_id = $1`, [
    instanceId,
  ]);
}

export { createFakeTransport };
