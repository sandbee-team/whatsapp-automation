import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  makeNoopPorts,
  PROBE_WORKER_ID,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import { FenceConflictError, type SessionStoreDb } from './types.js';
import { createSignalRedisRepo } from './redis-repo.js';
import { createAuthCodec } from './codec.js';
import { createEncryptedAuthStore } from './store.js';
import { FileKeyProvider } from '@wp/server-kit/crypto';

/**
 * store.c2-more.integration.test.ts (P07 close step C2, split of
 * store.c2.integration.test.ts purely to stay under the repo's `max-lines`
 * guard) - the remaining three of six C2 adversarial categories: retry
 * storm, a slow-rather-than-down Redis dependency, and session-epoch
 * stamping after a bump. See store.c2.integration.test.ts's own header for
 * the other three (crash mid-transaction, replay, two concurrent stores).
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

describe('C2: retry storm', () => {
  it('50_rapid_fire_saveCreds_from_the_live_owner_interleaved_with_external_cred_version_bumps_all_land_or_exhaust_cleanly_with_monotonic_versions', async () => {
    const fence = 30n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const ports = makeNoopPorts();
    const store = buildStore(handles, { instanceId, clientId, fence }, { ports });

    await store.saveCreds({ creds: { seq: 0 }, expectedVersion: 0n, fence });

    let externalBumps = 0;
    const externalBumpEvery = 7;
    const outcomes: Array<'landed' | 'exhausted'> = [];

    for (let i = 1; i <= 50; i += 1) {
      // External writer bumps cred_version every few writes (simulating
      // another legitimate writer on the SAME store/fence, e.g. a
      // concurrent setKeys-driven load or a different code path).
      if (i % externalBumpEvery === 0) {
        await handles.pool.query(
          'UPDATE whatsapp_session_credentials SET cred_version = cred_version + 1, updated_at = now() WHERE instance_id = $1',
          [instanceId],
        );
        externalBumps += 1;
      }

      // Each call passes a STALE expectedVersion (always 0n) so it always
      // needs at least one retry-reload cycle - the adversarial "retry
      // storm" shape - the store's own retry loop must always converge.
      try {
        await store.saveCreds({ creds: { seq: i }, expectedVersion: 0n, fence });
        outcomes.push('landed');
      } catch (err) {
        expect((err as Error).name).toBe('CredsSaveExhaustedError');
        outcomes.push('exhausted');
      }
    }

    // Ports never called (no fence conflict ever encountered - only
    // ordinary version_conflict retries and possibly clean exhaustion).
    expect(ports.onFenceConflict).not.toHaveBeenCalled();
    expect(ports.releaseLease).not.toHaveBeenCalled();

    // cred_version is monotonic (strictly non-decreasing across the whole
    // run is guaranteed by the UPDATE statement itself; here we just assert
    // the final value is coherent: 1 initial save + 50 storm attempts that
    // landed + externalBumps, with no gaps below that).
    const finalRow = await handles.pool.query<{ cred_version: string }>(
      'SELECT cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    const landedCount = outcomes.filter((o) => o === 'landed').length;
    const finalVersion = BigInt(finalRow.rows[0]?.cred_version ?? '0');
    // Every landed write bumps by 1; every external bump also bumps by 1;
    // the very first saveCreds above already bumped 0 -> 1.
    expect(finalVersion).toBe(1n + BigInt(landedCount) + BigInt(externalBumps));
    // The chain never deadlocked: we got exactly 50 outcomes, one per call.
    expect(outcomes).toHaveLength(50);
  }, 20000);
});

describe('C2: dependency slow-rather-than-down (Redis)', () => {
  it('setKeys_rejects_within_the_bound_when_the_underlying_redisSig_command_is_delayed_past_the_command_timeout', async () => {
    // FIX-A C2-F2 (was FINDING_PROBE_setKeys_hangs_until_a_delayed_redisSig_
    // hset_resolves_no_command_timeout_bounds_it): redis-repo.ts now wraps
    // every command (including the fence-gate EVAL that performs the HSET)
    // in the same bounded-timeout pattern as lease-redis.ts. This test
    // proxies the underlying command to delay far longer than a small
    // injected timeout and asserts the call rejects within that bound
    // instead of hanging.
    const fence = 40n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const provider = new FileKeyProvider({
      ringPath: handles.keyRingPath,
      mountedPurposes: ['session'],
    });
    const codec = createAuthCodec({ provider, encVersion: 1 });

    const COMMAND_TIMEOUT_MS = 50;
    const DELAY_MS = 5000; // far longer than COMMAND_TIMEOUT_MS
    let delayedCallObserved = false;
    const originalSendCommand = handles.redisSig.sendCommand.bind(handles.redisSig);
    const slowRedisSig = new Proxy(handles.redisSig, {
      get(target, prop, receiver) {
        if (prop === 'sendCommand') {
          return (...args: Parameters<typeof originalSendCommand>) => {
            const command = args[0] as { name?: string };
            if (command?.name === 'evalsha' || command?.name === 'eval') {
              delayedCallObserved = true;
              return new Promise((resolve, reject) => {
                setTimeout(() => {
                  (originalSendCommand(...args) as unknown as Promise<unknown>).then(
                    resolve,
                    reject,
                  );
                }, DELAY_MS);
              });
            }
            return originalSendCommand(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const redisRepo = createSignalRedisRepo({
      redisSig: slowRedisSig as never,
      redisCache: handles.redisCache,
      env: TEST_ENV,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const ports = makeNoopPorts();
    const store = createEncryptedAuthStore({
      db: handles.pool as unknown as SessionStoreDb,
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
      ports,
      metrics: {
        incrementHit: vi.fn(),
        incrementMiss: vi.fn(),
        incrementEvicted: vi.fn(),
        incrementDecryptFailure: vi.fn(),
      } as never,
    });

    const start = Date.now();
    await expect(
      store.setKeys({ session: { 's-slow': new Uint8Array([9]) } }, fence),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(delayedCallObserved).toBe(true);
    // Rejected close to the configured timeout, NOT anywhere near the full
    // injected delay - proves the call was actually raced against a bound
    // rather than simply waiting for the slow command to eventually settle.
    expect(elapsed).toBeLessThan(DELAY_MS / 2);
  });
});

describe('C2: session-epoch stamping after a bump', () => {
  it('a_stale_session_epoch_store_fails_closed_epoch_conflict_and_the_bumped_row_is_untouched', async () => {
    // FIX-A CRITICAL-1(c)/C2-F3 (was FINDING_PROBE_a_stale_session_epoch_
    // store_can_still_write_creds_stamping_the_old_epoch_onto_the_bumped_
    // row): `session-creds-upsert.sql` now ALSO requires
    // `whatsapp_instances.session_epoch = $session_epoch` (both arms) - a
    // store built with the OLD sessionEpoch, writing AFTER a purge bumped
    // `whatsapp_instances.session_epoch`, now misses that predicate even
    // though its fence is still numerically live. `classifyWriteMiss`
    // resolves the resulting zero-row miss to 'epoch_conflict' (fence/owner
    // both check out, only the epoch disagrees) and the store self-fences
    // exactly like a fence conflict - the write never lands, and the
    // already-bumped row is left completely untouched.
    const fence = 50n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    // Build a store at the OLD sessionEpoch (0) - as if constructed before
    // the purge/re-link bump below.
    const ports = makeNoopPorts();
    const staleEpochStore = buildStore(
      handles,
      { instanceId, clientId, fence, sessionEpoch: 0 },
      { ports },
    );
    await staleEpochStore.saveCreds({ creds: { pre: true }, expectedVersion: 0n, fence });

    // Simulate a purge + re-link: bump session_epoch on whatsapp_instances
    // directly (a real purge would also delete the creds row and bump the
    // fence - here we isolate JUST the epoch-stamping question by bumping
    // the instance epoch and re-minting the SAME fence value for a fresh
    // lease row, so the OLD store's fence still checks out as "live").
    await handles.pool.query(
      'UPDATE whatsapp_instances SET session_epoch = session_epoch + 1 WHERE id = $1',
      [instanceId],
    );
    const instanceAfterBump = await handles.pool.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceAfterBump.rows[0]?.session_epoch).toBe(1);

    const credsRowBefore = await handles.pool.query<{
      session_epoch: number;
      cred_version: string;
    }>(
      'SELECT session_epoch, cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );

    // The STALE-epoch store (still holding identity.sessionEpoch = 0)
    // writes again at the SAME (still-live) fence - now fails closed.
    await expect(
      staleEpochStore.saveCreds({ creds: { post: true }, expectedVersion: 1n, fence }),
    ).rejects.toThrow(FenceConflictError);
    expect(ports.onFenceConflict).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'epoch_conflict' }),
    );

    const credsRowAfter = await handles.pool.query<{ session_epoch: number; cred_version: string }>(
      'SELECT session_epoch, cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    // The bumped row is completely untouched by the rejected write.
    expect(credsRowAfter.rows[0]).toEqual(credsRowBefore.rows[0]);
  });
});
