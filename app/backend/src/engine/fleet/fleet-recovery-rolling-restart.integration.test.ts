import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupProbeClients as cleanupAuthStoreProbeClients } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { sysKey } from '../../platform/redis/keys.js';
import {
  createCountingSocketFactory,
  createSyntheticFleetHandles,
  createSyntheticWorker,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
  type SyntheticWorkerHandle,
} from '../session/synthetic-fleet-support.js';
import {
  SCAN_ROWS_PER_CYCLE,
  SESSION_CAP_HEADROOM,
  seedLinkedInstance,
  type SeededInstance,
} from './__tests__/fleet-recovery-test-support.js';

/**
 * fleet-recovery-rolling-restart.integration.test.ts (P09 U7 step 10,
 * FIX-P09-B split) - the rolling-deploy (graceful restart) half of
 * `fleet-recovery.integration.test.ts`, split out at FIX-P09-B for the
 * max-lines cap (topic split only - same case, unchanged), independent of
 * the storm exercise. See `fleet-recovery-storm.integration.test.ts` for
 * the kill -9 storm + fence-regression cases.
 *
 * Against SYNTHETIC mock-WS sockets only (see synthetic-fleet-support.ts's
 * own ABSOLUTE BOUNDARY doc comment), driven through real
 * `createSessionWorker` compositions over real Postgres/Redis - NO real
 * Baileys sockets, NO real WhatsApp numbers, NO real network. This test
 * proves behavior, not duration, and runs with real default TIMING (drain
 * proves a DIFFERENT property than the storm: a graceful roll, not a hard
 * kill).
 */

describe('fleet recovery harness - rolling restart', () => {
  let handles: SyntheticFleetHandles;
  const seededClientIds: string[] = [];
  const seededInstanceIds: string[] = [];
  const seededJobIds: string[] = [];

  afterAll(async () => {
    if (seededJobIds.length > 0) {
      await handles.pool.query('DELETE FROM message_jobs WHERE id = ANY($1::bigint[])', [
        seededJobIds,
      ]);
    }
    await cleanupAuthStoreProbeClients(handles.pool, seededClientIds);
    if (seededInstanceIds.length > 0) {
      await handles.pool.query(
        'DELETE FROM instance_lease_state WHERE instance_id = ANY($1::uuid[])',
        [seededInstanceIds],
      );
    }
    const leaseKeys = await handles.redisCtl.keys(`${sysKey('test')}*:lease:i:*`);
    if (leaseKeys.length > 0) {
      await handles.redisCtl.del(...leaseKeys);
    }
    await disposeSyntheticFleetHandles(handles);
  });

  it(
    'rolling_deploy_causes_zero_re_QR_and_zero_unresolved',
    async () => {
      handles = createSyntheticFleetHandles();

      // A fresh pair of instances + fresh two-worker pair, independent of
      // the storm exercise (drain proves a DIFFERENT property: a graceful
      // roll, not a hard kill).
      const ROLL_N = 4;
      const seeded: SeededInstance[] = [];
      for (let i = 0; i < ROLL_N; i += 1) {
        seeded.push(
          await seedLinkedInstance(handles, seededClientIds, seededInstanceIds, seededJobIds),
        );
      }
      const myInstanceIds = seeded.map((s) => s.instanceId);

      const counting = createCountingSocketFactory({ openAfterMs: 5 });

      async function ownedCount(
        a: SyntheticWorkerHandle,
        b: SyntheticWorkerHandle,
      ): Promise<number> {
        return myInstanceIds.filter((id) => a.worker.registry.has(id) || b.worker.registry.has(id))
          .length;
      }

      // Wall-clock-bounded (never iteration-count-bounded) for the same
      // reason the storm's own worker-A setup loop is: an unrelated seeded
      // fixture row occasionally winning the `ORDER BY random()` draw must
      // cost extra real 15s grace waits, never a hard iteration ceiling that
      // could give up before this file's own rows land.
      async function pollUntilAllOwned(
        a: SyntheticWorkerHandle,
        b: SyntheticWorkerHandle,
        deadline: number,
      ): Promise<void> {
        while (Date.now() < deadline && (await ownedCount(a, b)) < myInstanceIds.length) {
          // Alternate cycles so ownership genuinely splits across both
          // workers (each grab is exclusive - whichever worker's cycle
          // reaches a row first owns it) rather than one worker sweeping
          // everything.
          await a.runOneScanIteration();
          await b.runOneScanIteration();
        }
      }

      // Generous session caps (see the storm's own `SESSION_CAP_HEADROOM`
      // doc comment) - never pinned to `ROLL_N`, for the same
      // remainingCapacity-exhaustion reason.
      let w1 = createSyntheticWorker({
        handles,
        workerId: `worker-fleet-roll-1-${randomUUID()}`,
        socketFactory: counting.factory,
        maxScanRows: SCAN_ROWS_PER_CYCLE,
        sessionCap: SESSION_CAP_HEADROOM,
      });
      let w2 = createSyntheticWorker({
        handles,
        workerId: `worker-fleet-roll-2-${randomUUID()}`,
        socketFactory: counting.factory,
        maxScanRows: SCAN_ROWS_PER_CYCLE,
        sessionCap: SESSION_CAP_HEADROOM,
      });

      const ROLL_SETUP_BUDGET_MS = ROLL_N * 25_000;
      await pollUntilAllOwned(w1, w2, Date.now() + ROLL_SETUP_BUDGET_MS);
      expect(await ownedCount(w1, w2)).toBe(myInstanceIds.length);

      // Restart ONE AT A TIME via the real drain() path, then start a
      // replacement composition bound to the SAME shared counting factory.
      const drainResultW1 = await w1.drain();
      expect(drainResultW1.exitCode).toBe(0);
      w1 = createSyntheticWorker({
        handles,
        workerId: `worker-fleet-roll-1-replacement-${randomUUID()}`,
        socketFactory: counting.factory,
        maxScanRows: SCAN_ROWS_PER_CYCLE,
        sessionCap: SESSION_CAP_HEADROOM,
      });

      const drainResultW2 = await w2.drain();
      expect(drainResultW2.exitCode).toBe(0);
      w2 = createSyntheticWorker({
        handles,
        workerId: `worker-fleet-roll-2-replacement-${randomUUID()}`,
        socketFactory: counting.factory,
        maxScanRows: SCAN_ROWS_PER_CYCLE,
        sessionCap: SESSION_CAP_HEADROOM,
      });

      await pollUntilAllOwned(w1, w2, Date.now() + ROLL_SETUP_BUDGET_MS);

      // Every one of our instances re-owned and its socket re-opened after
      // the full roll.
      expect(await ownedCount(w1, w2)).toBe(myInstanceIds.length);

      // Zero QR emissions across the WHOLE exercise (sessions resumed from
      // stored creds).
      expect(counting.totalQrCount()).toBe(0);

      // Zero of our jobs in needs_reconcile or any failed/lost state - count
      // + status byte-identical to the seed (all still 'queued': no send
      // occurred, drain never touched a job that was never claimed).
      const result = await handles.pool.query<{ status: string }>(
        'SELECT status FROM message_jobs WHERE instance_id = ANY($1::uuid[])',
        [myInstanceIds],
      );
      expect(result.rows).toHaveLength(myInstanceIds.length);
      for (const row of result.rows) {
        expect(row.status).toBe('queued');
      }

      // Cleanup this test's own two replacement workers via their real
      // drain path too (afterAll only cleans up rows/handles).
      await w1.drain();
      await w2.drain();
    },
    // Two setup phases (initial split + post-roll re-acquisition), each
    // budgeted up to `ROLL_N(4) * 25_000`ms of real grace-bound grabs, plus
    // slack for drains/queries.
    2 * 4 * 25_000 + 30_000,
  );
});
