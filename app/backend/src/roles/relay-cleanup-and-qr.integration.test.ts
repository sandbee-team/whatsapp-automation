import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../platform/db/db-url.js';
import { drainOnce } from '../modules/events/relay-loop.js';
import { runOutboxCleanup } from '../modules/events/cleanup.js';
import { emit } from '../modules/events/emit.js';
import { createTenantDb, type TenantDb } from '@wp/db';
import {
  cleanupOutboxRows,
  createNoOpMetrics,
  createRecordingPublisher,
  newClientId,
  newInstanceId,
  seedOutboxRow,
  type TestPool,
} from './__tests__/relay-test-helpers.js';

/**
 * roles/relay-cleanup-and-qr.integration.test.ts (P15 U4, step 5) - the
 * bounded retention sweep and the QR-safety invariant, split from
 * `relay.integration.test.ts` for file size. The `wp_relay`-role-scoped
 * cleanup proof (F5 / MAJ-3) lives in the sibling
 * `relay-cleanup-role.integration.test.ts` (split out again at the 300-line
 * cap when that proof was added).
 *
 * NOT a role entrypoint (see `relay.integration.test.ts`'s own note on
 * `scripts/check-role-boot.ts`'s glob) - no `assertDbPreconditionsOrExit`
 * call here; that gate belongs to `roles/relay.ts`'s own `main()`.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-tests',
}) as unknown as TestPool;
const tenantDb: TenantDb = createTenantDb(pool as unknown as Parameters<typeof createTenantDb>[0]);

afterAll(async () => {
  await (pool as unknown as { end: () => Promise<void> }).end();
});

let seededClientIds: string[] = [];

afterEach(async () => {
  await cleanupOutboxRows(pool, seededClientIds);
  seededClientIds = [];
});

describe('runOutboxCleanup - bounded retention sweep', () => {
  it('cleanup_deletes_only_published_rows_and_is_bounded', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // P17 close (gate attempt 6): the sweep is cross-tenant and spends its
    // 5000-row budget oldest-first, so ANY foreign eligible (old-published)
    // row already in the shared dev table - e.g. notification.created rows
    // minted against db/seeds/queue-explain-fixture.sql's PERMANENT clients,
    // which no suite may delete - is swept BEFORE this test's own seeds and
    // shifts the exact remainder (observed: 27 foreign rows => 28 remained).
    // Sweep to exhaustion first so the exactness below starts from a
    // known-empty eligible set. This is garbage collection of PUBLISHED rows
    // only - precisely the sweep's own job - never a whole-table delete.
    let swept = await runOutboxCleanup({ pool: pool as never });
    while (swept > 0) {
      swept = await runOutboxCleanup({ pool: pool as never });
    }

    // BUG FIX (P15 C1 FIX, mechanical-conventions minor): the previous
    // version of this test seeded exactly ONE eligible (old-published) row
    // and asserted `toBeGreaterThanOrEqual(1)` - a bounds-only assertion the
    // mechanical conventions forbid (satisfied by a wrong implementation
    // that deletes everything). `runOutboxCleanup` sweeps CROSS-TENANT with
    // no client_id filter (by design), so an exact assertion on the eligible
    // set must seed enough of ITS OWN rows to dominate the default 5000-row
    // per-tick LIMIT regardless of any other row that might exist in the
    // table: 5001 eligible rows for this clientId means the sweep's LIMIT
    // 5000 is exhausted by rows this test controls, so EXACTLY 5000 are
    // deleted (never fewer, since 5001 >= 5000 eligible rows exist) and
    // exactly 1 of THIS test's own eligible rows remains afterwards.
    const eligibleIds: string[] = [];
    for (let i = 0; i < 5001; i += 1) {
      eligibleIds.push(
        await seedOutboxRow(pool, {
          clientId,
          instanceId,
          type: 'instance.health_changed',
          entityId: instanceId,
          payload: {
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          coalesceKey: `instance:${instanceId}:state:${String(i)}`,
          fanout: ['sse'],
          publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago - past the 1h retention window
        }),
      );
    }
    const recentPublishedId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
      publishedAt: new Date(), // just published - inside the retention window
    });
    const unpublishedId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
      publishedAt: null,
    });

    const deletedCount = await runOutboxCleanup({ pool: pool as never });

    expect(deletedCount).toBe(5000);

    const remainingEligible = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = ANY($1)',
      [eligibleIds],
    );
    expect(remainingEligible.rows).toHaveLength(1);

    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = ANY($1)',
      [[recentPublishedId, unpublishedId]],
    );
    const remainingIds = new Set(remaining.rows.map((row) => row.id));

    expect(remainingIds.has(recentPublishedId)).toBe(true);
    expect(remainingIds.has(unpublishedId)).toBe(true);
  });

  it('cleanup_is_bounded_by_limit_per_tick', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(
        await seedOutboxRow(pool, {
          clientId,
          instanceId,
          type: 'instance.health_changed',
          entityId: instanceId,
          payload: {
            instanceId,
            healthState: 'connected',
            pauseReason: null,
            needsUserAction: false,
          },
          coalesceKey: `instance:${instanceId}:state`,
          fanout: ['sse'],
          publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        }),
      );
    }

    const deletedCount = await runOutboxCleanup({ pool: pool as never, limit: 5 });

    expect(deletedCount).toBe(5);

    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = ANY($1)',
      [ids],
    );
    expect(remaining.rows).toHaveLength(7);
  });

  it('an_injected_non_default_retentionMs_is_honoured_not_just_the_1h_default', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // Never a `SELECT now()` round-trip compared against a LATER real
    // `now()` read inside `runOutboxCleanup`'s own query - two separate
    // live-clock reads a test round-trip apart is exactly the ambient-
    // timing trap this repo's own convention bans. `retentionMs` here is a
    // small, injected, non-default value (proving the parameter is actually
    // honoured, not hardcoded to the real 1h default) with a wide, fixed
    // 1-hour margin on the "past cutoff" fixture so no realistic test
    // round-trip latency can ever flip either row's classification.
    const literalNow = new Date('2026-09-02T12:00:00.000Z');
    const retentionMs = 60_000;

    const justPastCutoffId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
      // Comfortably older than literalNow - retentionMs, so it is deleted
      // regardless of how much real time elapses between this seed and the
      // cleanup call below.
      publishedAt: new Date(literalNow.getTime() - retentionMs - 60 * 60 * 1000),
    });
    const justInsideCutoffId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
      // Published "now" (real wall clock, always >= literalNow in this
      // fixed-past-date test) - always well inside the retention window,
      // kept regardless of test round-trip latency.
      publishedAt: new Date(),
    });

    await runOutboxCleanup({ pool: pool as never, retentionMs });

    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = ANY($1)',
      [[justPastCutoffId, justInsideCutoffId]],
    );
    const remainingIds = new Set(remaining.rows.map((row) => row.id));
    expect(remainingIds.has(justPastCutoffId)).toBe(false);
    expect(remainingIds.has(justInsideCutoffId)).toBe(true);
  });
});

describe('emit + drainOnce - instance.qr never enters the outbox', () => {
  it('an_instance_qr_event_can_never_be_written_to_the_outbox', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // emit() itself rejects instance.qr unconditionally - proven again here
    // (not just emit.test.ts) so this file's own claim about the FULL
    // relay-facing surface (no QR bytes in any outbox row, frame, log line
    // or metric label) is a single, self-contained proof.
    await expect(
      tenantDb.withTenant(clientId, async (tx) =>
        emit(tx, {
          clientId,
          instanceId,
          type: 'instance.qr',
          entityId: instanceId,
          payload: {
            instanceId,
            expiresAt: new Date().toISOString(),
            attemptsLeft: 3,
            payload: 'super-secret-qr-bearer-credential',
          },
          fanout: ['sse'],
        }),
      ),
    ).rejects.toThrow();

    const rows = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rows).toHaveLength(0);

    // The relay itself never claims/publishes ANY row for this clientId at
    // all - since emit() wrote zero rows, drainOnce has nothing to do for
    // this instance, so no QR bytes can reach a publisher call, a log line,
    // or a metric label through the relay path either (emit() IS the one
    // and only gate - instance.qr keeps its existing direct worker ->
    // redis-bridge leg and structurally never reaches drainOnce at all).
    const publisher = createRecordingPublisher();
    await drainOnce({
      pool,
      publisher,
      metrics: createNoOpMetrics(),
      clock: { now: () => new Date() },
    });
    const framedForThisInstance = publisher.calls.filter((call) => call.clientId === clientId);
    expect(framedForThisInstance).toHaveLength(0);
  });
});
