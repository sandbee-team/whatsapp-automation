import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  makeNoopMetrics,
  makeNoopPorts,
  writeTempSessionKeyRing,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import { createAuthCodec } from './codec.js';
import { createSignalRedisRepo } from './redis-repo.js';
import { createEncryptedAuthStore } from './store.js';
import type { SessionStoreDb } from './types.js';
import { FileKeyProvider } from '@wp/server-kit/crypto';

/**
 * wp-app-role.integration.test.ts (P07 FIX-B CRITICAL proof) - EVERY other
 * P07 auth-state integration test builds its store's `db` handle from the
 * bare dev/test pool (`handles.pool` in `store-fixtures.ts`'s `buildStore`),
 * which connects as the dev DB's own superuser/BYPASSRLS role - so none of
 * them ever proved the store works under the REAL production role, `wp_app`.
 * Migration 0010 left `whatsapp_instances` with NO wp_app grant at all
 * ("P08 owns this table's logic... adds whatever the connect/pair endpoints
 * need when it lands") - but `session-creds-upsert.sql`/
 * `session-creds-classify-miss.sql`/`session-purge-epoch-bump.sql` (all P07,
 * all pre-existing) already depend on reading/writing
 * `whatsapp_instances.id`/`.client_id`/`.session_epoch`/`.updated_at` UNDER
 * wp_app - a gap only migration 0021 (this fix) closes.
 *
 * Same reasoning as `lease-renew-cross-tenant-rls.integration.test.ts`'s own
 * header: an un-roled probe against a superuser pool would be vacuous for
 * RLS/grant purposes. This file builds a `SessionStoreDb` whose EVERY
 * statement - not just `purge`'s own transaction - runs under
 * `SET LOCAL ROLE wp_app` with `app.client_id` set, adapting
 * `engine/lease/test-support/worker-as-role.ts`'s `SET LOCAL ROLE` + GUC
 * pattern to the store's two-shaped `SessionStoreDb` surface (`.query()` for
 * every method except `purge`, `.connect()` for purge's own hand-rolled
 * transaction) rather than weakening the store's API for testability.
 *
 * Written to fail RED against the pre-0021 tree (migration 0021 not yet
 * applied): under `wp_app` with no `whatsapp_instances` grant at all, the
 * `EXISTS (SELECT 1 FROM whatsapp_instances ...)` subqueries in
 * `session-creds-upsert.sql`/`session-creds-classify-miss.sql` and the
 * `UPDATE whatsapp_instances SET session_epoch = ...` in
 * `session-purge-epoch-bump.sql` all raise Postgres error 42501
 * (insufficient_privilege) - `saveCreds`/`purge` reject instead of
 * completing.
 */

type TestPool = StoreTestHandles['pool'];

let handles: StoreTestHandles;
let probeClientIds: string[] = [];

beforeAll(() => {
  handles = createStoreTestHandles();
});

afterAll(async () => {
  await disposeStoreTestHandles(handles);
});

afterEach(async () => {
  await cleanupProbeClients(handles.pool, probeClientIds);
  probeClientIds = [];
});

const PROBE_WORKER_ID = 'worker-wp-app-role-probe';

/** Seeds `clients`/`whatsapp_instances`/`instance_lease_state` rows as the (superuser) test pool - the seed itself is not part of the proof. */
async function seedTenantInstanceAndLease(
  pool: TestPool,
  fence: bigint,
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'WP App Role Probe Client',
    `wp-app-role-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, $3, $4, now())`,
    [instanceId, clientId, fence.toString(), PROBE_WORKER_ID],
  );

  return { clientId, instanceId };
}

/**
 * Builds a `SessionStoreDb` where EVERY statement - not just `purge`'s own
 * transaction - runs under `SET LOCAL ROLE wp_app` with `app.client_id` set
 * for `clientId`. `store.ts`/`pg-repo.ts` call `db.query(...)` directly with
 * no transaction wrapper of their own for every method except `purge` (which
 * owns its own `BEGIN`/`COMMIT` via `db.connect()`) - so each `.query()` call
 * here opens its own short-lived transaction (role + GUC are transaction-
 * local, per `tenant-db.ts`'s own doc comments) around exactly one statement,
 * mirroring `wp-app-role.ts`'s `wrapAsRole` (which does the same thing for
 * a `{connect(): Promise<WrappedClient>}` shape) adapted to the store's
 * `SessionRepoQueryable.query` + `.connect()` combined surface.
 */
function createSessionStoreDbAsWpApp(pool: TestPool, clientId: string): SessionStoreDb {
  async function withRoleTransaction<T>(fn: (client: TestPoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let releaseError: unknown;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE wp_app');
        await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
          releaseError = undefined;
        } catch (rollbackErr) {
          releaseError = rollbackErr;
        }
        throw err;
      }
    } finally {
      if (releaseError !== undefined) {
        client.release(releaseError as Error);
      } else {
        client.release();
      }
    }
  }

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }> {
      return withRoleTransaction((client) => client.query<T>(sql, params));
    },
    async connect() {
      // `purge`'s own hand-rolled transaction: the FIRST statement it sends
      // is `BEGIN` (see `store-purge.ts`) - piggyback the role switch + GUC
      // onto that same `BEGIN`, exactly like `wp-app-role.ts`'s `wrapAsRole`
      // does for its own `{connect(): Promise<WrappedClient>}` shape.
      const client = await pool.connect();
      return {
        async query<T extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<{ rows: T[]; rowCount: number | null }> {
          const result = await client.query<T>(sql, params as unknown[] | undefined);
          if (/^BEGIN\b/.test(sql.trim().toUpperCase())) {
            await client.query('SET LOCAL ROLE wp_app');
            await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
          }
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release(err?: Error) {
          client.release(err);
        },
      };
    },
  };
}

interface TestPoolClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

describe('auth-state store under the real wp_app role', () => {
  it('saveCreds_setKeys_loadCreds_getKeys_and_purge_all_succeed_under_wp_app', async () => {
    const fence = 11n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const dbAsWpApp = createSessionStoreDbAsWpApp(handles.pool, clientId);

    const provider = new FileKeyProvider({
      ringPath: writeTempSessionKeyRing(),
      mountedPurposes: ['session'],
    });
    const codec = createAuthCodec({ provider, encVersion: 1 });
    const redisRepo = createSignalRedisRepo({
      redisSig: handles.redisSig,
      redisCache: handles.redisCache,
      env: TEST_ENV,
    });

    const store = createEncryptedAuthStore({
      db: dbAsWpApp,
      redisRepo,
      codec,
      identity: {
        instanceId,
        clientId,
        sessionEpoch: 0,
        fence,
        env: TEST_ENV,
        workerId: PROBE_WORKER_ID,
      },
      ports: makeNoopPorts(),
      metrics: makeNoopMetrics(),
    });

    // 1. First saveCreds (INSERT arm - depends on the whatsapp_instances
    // EXISTS predicate in session-creds-upsert.sql, which needs SELECT
    // (id, client_id, session_epoch) under wp_app).
    await expect(store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence })).resolves.toEqual(
      { credVersion: 1n },
    );

    // 2. A durable setKeys (session-keys-upsert.sql - same whatsapp_instances
    // EXISTS predicate, FIX-B SUGGESTION-7).
    await expect(
      store.setKeys(
        { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
        fence,
      ),
    ).resolves.toBeUndefined();

    // 3. loadCreds/getKeys (read-only, no fence predicate, but still run
    // through the same role-wrapped db).
    const loaded = await store.loadCreds();
    expect(loaded).not.toBeNull();

    const keys = await store.getKeys('pre-key', ['k-1']);
    expect(keys['k-1']).toBeDefined();

    // 4. purge - depends on session-purge-epoch-bump.sql's
    // UPDATE (session_epoch, updated_at) grant under wp_app.
    const purgeResult = await store.purge(fence);
    expect(purgeResult).toEqual({ purged: true });

    // The epoch bump landed (verified via the superuser pool - reading back
    // is not part of what wp_app needs to prove, only the write itself).
    const instanceRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.session_epoch).toBe(1);

    const credsRow = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsRow.rows.length).toBe(0);
  });
});
