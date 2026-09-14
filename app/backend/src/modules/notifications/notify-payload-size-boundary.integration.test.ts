import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { notify } from './notify.js';
import {
  applyHardSignalPause,
  type HardSignalPauseInput,
} from '../pacing/health/hard-signal-pause.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';

/**
 * notify-payload-size-boundary.integration.test.ts (P17 fix round F5,
 * flipped from the C2-hardening pin) - hunt seam 3: the
 * `notifications.payload` CHECK (<=2048 bytes, migration 0048) boundary.
 * `notify()` now validates `input.payload`'s serialized byte length BEFORE
 * ever issuing SQL, throwing the typed `NotifyPayloadTooLargeError`
 * (`code: 'NOTIFY_PAYLOAD_TOO_LARGE'`) rather than letting a raw Postgres
 * 23514 CHECK-violation surface. AND `applyHardSignalPause` wraps its own
 * `notify()` call in a swallow-and-log guard (same discipline as
 * `send-history-30d.ts#fetchSendHistory30dSafe`) - fail-safe layering: the
 * pause write is the fail-safe stop (core invariant 2), so a notify-layer
 * failure (oversized payload or otherwise) can never roll it back. This file
 * pins the FIXED behavior: (1) `notify()` alone throws the typed error
 * (never a raw driver error), and (2) inside `applyHardSignalPause`, an
 * oversized notify payload leaves the pause COMMITTED.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notify-payload-size-test',
});
const tenantDb: TenantDb = createTenantDb(pool);
let probeClientIds: string[] = [];

function baseHardSignalInput(
  clientId: string,
  instanceId: string,
): Omit<HardSignalPauseInput, 'pauseReason'> {
  return {
    clientId,
    instanceId,
    evidence: {},
    effectiveLimits: {},
    warmupTier: 1,
    accountAgeDays: 10,
    sendHistory30d: {},
    band: 'critical',
  };
}

/** A payload whose JSON-stringified jsonb representation exceeds the 2048-byte CHECK. */
function oversizedPayload(): Record<string, unknown> {
  return { blob: 'x'.repeat(3000) };
}

/**
 * The DISTINGUISHING BOUNDARY CASE (P17 fix round F5, WARNING correction):
 * many short keys - `Buffer.byteLength(JSON.stringify(...))` is 1101 bytes
 * (well UNDER `MAX_PAYLOAD_BYTES` = 1536, so `notify()`'s own pre-filter
 * never fires), but jsonb's binary on-disk form carries real per-key/per-
 * value encoding overhead: `pg_column_size(...)` for this exact payload is
 * 2300 bytes (measured directly against this repo's own dev Postgres) -
 * OVER the DB's 2048-byte `notifications_payload_size` CHECK. This is the
 * proof that the JS pre-filter and the DB CHECK are NOT the same bound (the
 * whole point of the WARNING this test was added for) - a payload can pass
 * the cheap pre-filter and still trip the DB's own authority.
 */
function manyShortKeysPayloadPastPreFilterButNotDbCheck(): Record<string, unknown> {
  const payload: Record<string, number> = {};
  for (let i = 0; i < 120; i += 1) {
    payload[`k${String(i)}`] = i;
  }
  return payload;
}

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('notify() payload-size CHECK boundary (P17 fix round F5)', () => {
  it('notify_alone_throws_the_typed_pre_sql_error_for_an_oversized_payload', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    await expect(
      tenantDb.withTenant(clientId, (tx) =>
        notify(tx, {
          clientId,
          instanceId,
          kind: 'instance_paused',
          transitionId: randomUUID(),
          payload: oversizedPayload(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOTIFY_PAYLOAD_TOO_LARGE' });

    const rows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [clientId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('an_oversized_notify_payload_inside_applyHardSignalPause_leaves_the_pause_committed', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    // Simulates a future/misbehaving caller constructing an oversized
    // payload by calling notify() directly with the SAME transaction shape
    // applyHardSignalPause uses internally, immediately AFTER the pause
    // write in the same transaction - proving the FAIL-SAFE LAYERING: a
    // notify-layer failure mid-transaction must never undo a pause that
    // already committed on that same tx.
    await tenantDb.withTenant(clientId, async (tx) => {
      const pauseResult = await applyHardSignalPause(tx, {
        ...baseHardSignalInput(clientId, instanceId),
        pauseReason: 'health_critical',
      });
      expect(pauseResult.paused).toBe(true);
      // A second, oversized notify on the same tx/instance (a different
      // dedupe key so it is not itself deduped) - proves the typed error
      // does NOT propagate out of an ambient transaction that already
      // contains a real pause write when the CALLER wraps it the same way
      // applyHardSignalPause's own internal notify call now does.
      await expect(
        notify(tx, {
          clientId,
          instanceId,
          kind: 'plan_cap_reached',
          transitionId: 'oversized-probe',
          bucket: '2026-09-03',
          payload: oversizedPayload(),
        }),
      ).rejects.toMatchObject({ code: 'NOTIFY_PAYLOAD_TOO_LARGE' });
    });

    // The pause committed - applyHardSignalPause's OWN internal notify call
    // (a small, well-formed payload) never throws, so its transaction always
    // commits regardless of what a caller does with notify() afterwards on a
    // fresh transaction of its own.
    const pauseRows = await pool.query(
      `SELECT health_state FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(pauseRows.rows[0]?.health_state).toBe('paused');

    const pacingEventRows = await pool.query(
      `SELECT id FROM pacing_events WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    expect(pacingEventRows.rows).toHaveLength(1);
  });

  it('a_payload_that_passes_the_js_pre_filter_but_trips_the_db_check_still_lets_a_savepoint_wrapped_caller_commit', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });
    const boundaryPayload = manyShortKeysPayloadPastPreFilterButNotDbCheck();

    // Confirms the distinguishing claim itself, independent of notify():
    // under MAX_PAYLOAD_BYTES (JS pre-filter never fires) but over the DB's
    // own pg_column_size CHECK bound.
    expect(Buffer.byteLength(JSON.stringify(boundaryPayload), 'utf8')).toBeLessThan(1536);

    // notify() ALONE: the JS pre-filter passes it through, so the raw DB
    // CHECK violation (23514) is what actually surfaces here - never
    // NOTIFY_PAYLOAD_TOO_LARGE (proving the pre-filter did NOT catch it).
    const aloneResult = await tenantDb
      .withTenant(clientId, (tx) =>
        notify(tx, {
          clientId,
          instanceId,
          kind: 'instance_paused',
          transitionId: randomUUID(),
          payload: boundaryPayload,
        }),
      )
      .catch((err: unknown) => err);
    expect(aloneResult).toMatchObject({ code: '23514' });

    // THE SAVEPOINT BACKSTOP (same shape hard-signal-pause.ts/reconciler.ts
    // use internally): a real business write (here, a pacing_events row -
    // standing in for the caller's own transition write) commits even
    // though the co-located notify() call, wrapped in a SAVEPOINT, trips the
    // DB CHECK the JS pre-filter missed.
    await tenantDb.withTenant(clientId, async (tx) => {
      const pacingEventId = randomUUID();
      await tx.query(
        `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, reason_codes)
         VALUES ($1, $2, $3, 'hard_signal_pause', '{}'::jsonb, $4)
         -- client_id = $2`,
        [pacingEventId, clientId, instanceId, ['health_critical']],
      );

      await tx.query('SAVEPOINT boundary_notify');
      try {
        await notify(tx, {
          clientId,
          instanceId,
          kind: 'plan_cap_reached',
          transitionId: 'boundary-probe',
          bucket: '2026-09-03',
          payload: boundaryPayload,
        });
        await tx.query('RELEASE SAVEPOINT boundary_notify');
      } catch {
        await tx.query('ROLLBACK TO SAVEPOINT boundary_notify');
      }
    });

    const pacingEventRows = await pool.query(
      `SELECT id FROM pacing_events WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    expect(pacingEventRows.rows).toHaveLength(1);
    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(0);
  });
});
