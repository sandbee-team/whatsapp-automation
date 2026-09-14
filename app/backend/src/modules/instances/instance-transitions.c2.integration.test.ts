import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import {
  buildStore,
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  PROBE_WORKER_ID,
  seedTenantInstanceAndLease,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { runLoggedOutFlow, type InstanceServiceDeps } from './service.js';
import { beginPairingIntent } from './repo.js';
import { ctxFor } from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.c2.integration.test.ts (P08 C2) - two NEW cases the
 * E3 pass did not cover:
 *
 * 1. After a crash between `markLoggedOut` and the purge (documented ordering
 *    in service.ts's header), re-running the REPAIR path (a fresh
 *    `EncryptedAuthStore` built at the SAME fence, since a real store
 *    self-fences after any `purge()` resolution - store.ts's `markPurged`
 *    doc comment) completes the purge idempotently: creds/keys rows gone,
 *    `session_epoch` bumped exactly once, no second `session.purge` audit
 *    row (store-purge.ts's own C2-F1 no-op-replay contract).
 * 2. `beginPairingIntent` replayed twice (route double-submit) is a no-op on
 *    the second call in the sense that matters: it still returns true (the
 *    row still matches client+instance), but resets `qr_attempts` to 0 and
 *    advances `pairing_started_at` again - i.e. the SECOND call is not
 *    silently ignored, it is a fresh, idempotent re-arm of the SAME pairing
 *    window (never doubles/accumulates attempts).
 */

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

describe('logged_out crash-window repair is idempotent on retry', () => {
  it('a_fresh_store_replay_of_the_purge_after_a_crash_completes_exactly_once', async () => {
    const fence = 31n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });
    await store.saveCreds({ creds: { a: 1 }, expectedVersion: 0n, fence });
    await store.setKeys({ session: { 's-1': new Uint8Array([9]) } }, fence);

    const deps: InstanceServiceDeps = {
      ctx: ctxFor(handles.pool, clientId),
      auditSql: handles.pool as never,
    };

    // Pass 1: markLoggedOut lands, but the purge crashes (same technique as
    // the E3 test) - creds/keys/epoch untouched, state already logged_out.
    let queryCount = 0;
    const realClient = await handles.pool.connect();
    const killingClient = {
      query: (...args: Parameters<typeof realClient.query>) => {
        queryCount += 1;
        if (queryCount === 4) {
          throw new Error('SIMULATED_CONNECTION_KILL');
        }
        return (realClient.query as (...a: unknown[]) => unknown)(...args);
      },
      release: (err?: Error) => realClient.release(err),
    };
    const killingDb = {
      query: (sql: string, params?: unknown[]) => handles.pool.query(sql, params as never) as never,
      connect: async () => killingClient as never,
    };

    const provider = new FileKeyProvider({
      ringPath: handles.keyRingPath,
      mountedPurposes: ['session'],
    });
    const { createAuthCodec } = await import('../../provider/baileys/auth-state/codec.js');
    const { createSignalRedisRepo } =
      await import('../../provider/baileys/auth-state/redis-repo.js');
    const { createEncryptedAuthStore } = await import('../../provider/baileys/auth-state/store.js');
    const codec = createAuthCodec({ provider, encVersion: 1 });
    const redisRepo = createSignalRedisRepo({
      redisSig: handles.redisSig,
      redisCache: handles.redisCache,
      env: 'test',
    });

    const killingStore = createEncryptedAuthStore({
      db: killingDb as never,
      redisRepo,
      codec,
      identity: {
        instanceId,
        clientId,
        sessionEpoch: 0,
        fence,
        env: 'test',
        workerId: PROBE_WORKER_ID,
      },
      ports: {
        onFenceConflict: vi.fn().mockResolvedValue(undefined),
        onSignalWriteFailure: vi.fn().mockResolvedValue(undefined),
        releaseLease: vi.fn().mockResolvedValue(undefined),
      },
      metrics: {
        incrementHit: vi.fn(),
        incrementMiss: vi.fn(),
        incrementEvicted: vi.fn(),
        incrementDecryptFailure: vi.fn(),
      } as never,
    });

    await expect(
      runLoggedOutFlow(deps, {
        instanceId,
        fence,
        workerId: PROBE_WORKER_ID,
        authStore: killingStore,
      }),
    ).rejects.toThrow('SIMULATED_CONNECTION_KILL');

    // Recorded ordering holds: state already logged_out, creds still present.
    const midway = await handles.pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(midway.rows[0]?.health_state).toBe('logged_out');
    const credsMidway = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsMidway.rows.length).toBe(1);

    // Pass 2 (the repair/relink path): a FRESH store at the SAME fence (the
    // original `store` object is a separate, still-live instance and was
    // never itself purged - a real repair path builds a brand-new store the
    // same way runner.ts's buildAuthStore always does) replays the purge.
    const repairStore = buildStore(handles, { instanceId, clientId, fence });
    const result = await repairStore.purge(fence);
    expect(result.purged).toBe(true);

    const creds = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(creds.rows.length).toBe(0);
    const keys = await handles.pool.query(
      'SELECT 1 FROM whatsapp_session_keys WHERE instance_id = $1',
      [instanceId],
    );
    expect(keys.rows.length).toBe(0);
    const epochRow = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(epochRow.rows[0]?.session_epoch).toBe(1);

    // Pass 3: replay the SAME purge AGAIN (e.g. a second retry of the repair
    // path) - true no-op, epoch stays at 1, no second audit row.
    const secondRepairStore = buildStore(handles, { instanceId, clientId, fence });
    const replay = await secondRepairStore.purge(fence);
    expect(replay.purged).toBe(false);

    const epochAfterReplay = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(epochAfterReplay.rows[0]?.session_epoch).toBe(1);

    const purgeAuditRows = await handles.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'session.purge'`,
      [instanceId],
    );
    expect(purgeAuditRows.rows.length).toBe(1);
  });
});

describe('beginPairingIntent double-submit is a safe re-arm, not a doubled counter', () => {
  it('a_replayed_begin_pairing_call_resets_attempts_and_advances_the_window_again', async () => {
    const fence = 32n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);
    const ctx = ctxFor(handles.pool, clientId);

    const { incrementQrAttempts } = await import('./repo.js');

    // First submit: begin pairing, then burn 3 attempts.
    const firstOk = await beginPairingIntent(ctx, instanceId);
    expect(firstOk).toBe(true);
    await incrementQrAttempts(ctx, { instanceId, fence, workerId: PROBE_WORKER_ID });
    await incrementQrAttempts(ctx, { instanceId, fence, workerId: PROBE_WORKER_ID });
    const afterThree = await incrementQrAttempts(ctx, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
    });
    expect(afterThree.qrAttempts).toBe(3);

    const rowBeforeReplay = await handles.pool.query<{ pairing_started_at: Date }>(
      'SELECT pairing_started_at FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    const startedAtBeforeReplay = rowBeforeReplay.rows[0]?.pairing_started_at;
    expect(startedAtBeforeReplay).toBeDefined();

    // Second submit (double-submit replay, e.g. a double-click on the
    // dashboard's "start pairing" button): must be idempotent in the sense
    // that it re-arms a FRESH window rather than silently no-op-ing or
    // accumulating - qr_attempts resets to 0, pairing_started_at advances.
    const secondOk = await beginPairingIntent(ctx, instanceId);
    expect(secondOk).toBe(true);

    const rowAfterReplay = await handles.pool.query<{
      qr_attempts: number;
      pairing_started_at: Date;
      needs_user_action: boolean;
    }>(
      'SELECT qr_attempts, pairing_started_at, needs_user_action FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(rowAfterReplay.rows[0]?.qr_attempts).toBe(0);
    expect(rowAfterReplay.rows[0]?.needs_user_action).toBe(false);
    expect(rowAfterReplay.rows[0]?.pairing_started_at.getTime()).toBeGreaterThanOrEqual(
      startedAtBeforeReplay!.getTime(),
    );

    // A THIRD replay in immediate succession is equally safe (never throws,
    // never double-writes an audit row - beginPairing has none per service.ts).
    const thirdOk = await beginPairingIntent(ctx, instanceId);
    expect(thirdOk).toBe(true);
  });
});
