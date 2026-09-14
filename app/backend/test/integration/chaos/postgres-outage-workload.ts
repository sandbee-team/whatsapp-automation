// priority_rank IS the DWRR band weight (HIGH 6 / NORMAL 3 / LOW 1) - the send loop claims
// `j.priority_rank = $band` with exactly these values; a literal 10 is unclaimable (P26 run log #13).
import { DEFAULT_BAND_WEIGHTS } from '@wp/domain';
import { randomUUID } from 'node:crypto';
import { createPool, type CreatePoolOptions } from '@wp/db';
import { mintBoundedOffsetInstanceId } from '../../../src/engine/session/synthetic-fleet-support.js';
import {
  buildStore,
  type StoreTestHandles,
} from '../../../src/provider/baileys/auth-state/__tests__/store-fixtures.js';
import {
  createCredsSaveBuffer,
  type CredsSaveBuffer,
} from '../../../src/provider/baileys/auth-state/creds-save-buffer.js';
import { isPgUnavailableError } from '../../../src/provider/baileys/auth-state/pg-unavailable.js';
import type { EncryptedAuthStore } from '../../../src/provider/baileys/auth-state/types.js';

/**
 * postgres-outage-workload.ts (P26 U6a, step 6 chaos: Postgres outage) -
 * shared seed/proxy/cleanup helpers for `postgres-outage.integration.test.ts`.
 * NOT itself a test file (no `.test.ts` suffix).
 *
 * `createFailingPoolProxy` wraps a REAL `pg.Pool` so that while
 * `outage.active === true`, every `.query()`/`.connect()` call rejects with a
 * synthetic pg-shaped `57P01` error - `createTenantDb`/`createWorkerDb`/
 * `discovery.ts` all only ever need `.query`/`.connect` (never any other
 * `pg.Pool` method), so this narrow proxy is sufficient to make EVERY PG path
 * the worker uses see the outage, while Redis (a separate connection this
 * proxy never touches) stays healthy.
 */

/** Never imports `pg` directly - `app/backend` has no direct `pg` dependency (same idiom as `run-restore-verify-checks.ts`'s own `Pool` type alias). */
type Pool = ReturnType<typeof createPool>;

export interface OutageSwitch {
  active: boolean;
}

/** A synthetic pg-shaped connection-unavailable error - matches `pg-unavailable.ts`'s own classifier (SQLSTATE 57P01). */
export function makePgUnavailableError(): Error & { code: string } {
  const err = new Error('terminating connection due to administrator command') as Error & {
    code: string;
  };
  err.code = '57P01';
  return err;
}

/**
 * Wraps a real `pg.Pool` with an outage gate over `.query()`/`.connect()`
 * only - every other property/method passes through to the real pool
 * unchanged (e.g. `.end()` for cleanup, which must always work regardless of
 * `outage.active`).
 */
export function createFailingPoolProxy(realPool: Pool, outage: OutageSwitch): Pool {
  return new Proxy(realPool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          if (outage.active) {
            return Promise.reject(makePgUnavailableError());
          }
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === 'connect') {
        return (...args: unknown[]) => {
          if (outage.active) {
            return Promise.reject(makePgUnavailableError());
          }
          return (target.connect as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Pool;
}

export function createRealPoolForOutageTest(options: CreatePoolOptions): Pool {
  return createPool(options);
}

export interface SeededOutageInstance {
  clientId: string;
  instanceId: string;
  jobIds: string[];
  /** The seeded lease row's `owner_worker_id` - a caller building its OWN `buildStore` against this same instance (e.g. for a direct buffer test) must pass this as `workerId`, or every write misses as a fence conflict against `PROBE_WORKER_ID`, the default. */
  workerId: string;
}

/**
 * Seeds one client + one linked, online instance + a placeholder lease row
 * (fence 1, precondition for `buildStore`'s creds upsert, same idiom as
 * `fleet-recovery-test-support.ts#seedLinkedInstance`) + real encrypted
 * creds + `jobsPerInstance` queued `message_jobs` rows. Uses the REAL
 * (non-proxied) pool for seeding - the outage is flipped on only AFTER setup.
 */
export async function seedOutageInstance(
  realPool: Pool,
  storeHandles: StoreTestHandles,
  jobsPerInstance: number,
): Promise<SeededOutageInstance> {
  const clientId = randomUUID();
  const instanceId = mintBoundedOffsetInstanceId();
  const seedWorkerId = `worker-postgres-outage-seed-${randomUUID()}`;

  await realPool.query(
    'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
    [clientId, 'Postgres Outage Probe', `postgres-outage-probe-${clientId}`, 'active'],
  );
  await realPool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, 'probe', 'connected', 'linked', 'online', 0)`,
    [instanceId, clientId],
  );
  await realPool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, 1, $3, NULL)`,
    [instanceId, clientId, seedWorkerId],
  );

  const store = buildStore(
    { ...storeHandles, pool: realPool },
    { instanceId, clientId, fence: 1n, workerId: seedWorkerId },
  );
  await store.saveCreds({ creds: { seeded: true }, expectedVersion: 0n, fence: 1n });

  const jobIds: string[] = [];
  for (let i = 0; i < jobsPerInstance; i += 1) {
    const result = await realPool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', ${DEFAULT_BAND_WEIGHTS.NORMAL}, 'queued', now(), now())
       RETURNING id`,
      [
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        JSON.stringify({ text: `postgres-outage-probe-${String(i)}` }),
      ],
    );
    const row = result.rows[0];
    if (row) jobIds.push(row.id);
  }

  return { clientId, instanceId, jobIds, workerId: seedWorkerId };
}

export async function jobStatusesFor(realPool: Pool, jobIds: string[]): Promise<string[]> {
  const result = await realPool.query<{ status: string }>(
    'SELECT status FROM message_jobs WHERE id = ANY($1) ORDER BY id',
    [jobIds],
  );
  return result.rows.map((r) => r.status);
}

export async function sendAttemptsCountFor(realPool: Pool, jobIds: string[]): Promise<number> {
  const result = await realPool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM send_attempts WHERE message_job_id = ANY($1::bigint[])',
    [jobIds],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function cleanupOutageProbes(realPool: Pool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await realPool.query(
    'DELETE FROM send_attempts WHERE message_job_id IN (SELECT id FROM message_jobs WHERE client_id = ANY($1))',
    [clientIds],
  );
  await realPool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
  await realPool.query('DELETE FROM whatsapp_session_keys WHERE client_id = ANY($1)', [clientIds]);
  await realPool.query('DELETE FROM whatsapp_session_credentials WHERE client_id = ANY($1)', [
    clientIds,
  ]);
  await realPool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [clientIds]);
  await realPool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await realPool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

/**
 * Builds a `CredsSaveBuffer` wrapping `store.saveCreds`, but with `saveCreds`
 * gated by `outage` (never the real proxy pool) - a UNIT-level double of the
 * chaos scenario used by the two buffer-behaviour tests, which only need the
 * store's real fence/version enforcement, not the whole worker composition.
 *
 * FIX-P26-G: `saveCreds` now passes through the store's resolved
 * `{ credVersion }` instead of discarding it (the buffer's own port widened
 * to match); `readExpectedVersion` reads the SAME live value a real runner
 * would track, via the caller-supplied `readExpectedVersion` param - this
 * double has no `RunnerSessionState` of its own to close over.
 *
 * FIX-P26-I (CRITICAL 1+2, round-3 reviewer): `readExpectedVersion` and
 * `onFlushed` are the SAME live-version contract a real runner has - the
 * caller owns a mutable `liveVersion` variable (seeded to the row's actual
 * `cred_version`, written by `seedOutageInstance`'s own `saveCreds` call),
 * passes `() => liveVersion` here, and its `onFlushed` callback advances that
 * variable. Without this, `readExpectedVersion` returning a value stale
 * relative to the row's real version causes every flush to miss its UPDATE
 * (version_conflict), reload, and retry at version+1 - masking the
 * inefficiency this double exists to model.
 */
export function buildOutageGatedBuffer(
  store: EncryptedAuthStore,
  outage: OutageSwitch,
  readExpectedVersion: () => bigint,
  onFlushed?: (credVersion: bigint) => void,
): CredsSaveBuffer {
  return createCredsSaveBuffer({
    saveCreds: async (args) => {
      if (outage.active) {
        throw makePgUnavailableError();
      }
      return store.saveCreds(args);
    },
    isPgUnavailable: isPgUnavailableError,
    now: () => Date.now(),
    schedule: () => ({ cancel: () => undefined }),
    readExpectedVersion,
    onFlushed,
  });
}

/**
 * FIX-P26-I: the two buffer-behaviour tests share this exact wiring - a
 * mutable `liveVersion` seeded at 1n (the row's real seeded version) that
 * `onFlushed` advances. Factored out so each test's own body only needs to
 * read `getLiveVersion()` if it cares, never re-declare the closure.
 */
export function buildOutageGatedBufferWithLiveVersion(
  store: EncryptedAuthStore,
  outage: OutageSwitch,
): { buffer: CredsSaveBuffer; getLiveVersion: () => bigint } {
  let liveVersion = 1n;
  const buffer = buildOutageGatedBuffer(
    store,
    outage,
    () => liveVersion,
    (credVersion) => {
      liveVersion = credVersion;
    },
  );
  return { buffer, getLiveVersion: () => liveVersion };
}

/** Bounded-wait poll: retries `predicate` until it resolves true or `deadlineMs` elapses. Never a bare sleep - the caller asserts the OUTCOME after this resolves, never elapsed time. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  deadlineMs: number,
  pollMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
