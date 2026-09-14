import type { TenantDb, TenantQueryable } from '@wp/db';
import type { QueueMetricsHandles } from '../../../engine/queue/metrics.js';
import { createCountingNoOpRepairedSendSink } from '../repaired-send-sink.js';
import type { ReaperDeps } from '../reaper.js';
import type { TestPool } from '../../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * reaper-prepared-collision-helpers.ts (P12 C1 review, CRITICAL finding 1) -
 * shared fixtures for `reaper-prepared-collision.integration.test.ts` and
 * `reaper-prepared-collision-loop.integration.test.ts` (split at the
 * max-lines cap - both files drive the SAME crash-then-reap-then-redispatch
 * scenario, one as a single cycle, one as a repeated loop proving
 * termination). Lives under `__tests__/` so the tenant-scope guard's
 * seed/cleanup exemption covers its raw queries (same convention as
 * `queue-send-test-helpers.ts`'s own header).
 */

export class SimulatedCrashAfterFirstTransaction extends Error {
  constructor() {
    super('simulated crash: process died between prepareAndIncrement and markDispatched');
    this.name = 'SimulatedCrashAfterFirstTransaction';
  }
}

/**
 * Same idiom as `result-crash-window.integration.test.ts`'s own helper: the
 * FIRST `withTenant` call runs for real (and commits - `dispatch()`'s
 * `prepareAndIncrement` step), every LATER call throws before opening its
 * own transaction (`dispatch()`'s `markDispatched` step never lands) -
 * modelling a crash after the attempt row commits but before the provider
 * is ever contacted, the exact `prepared` state finding 1's whole mechanism
 * depends on.
 */
export function crashAfterFirstTransaction(real: TenantDb): TenantDb {
  let calls = 0;
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      calls += 1;
      if (calls > 1) {
        throw new SimulatedCrashAfterFirstTransaction();
      }
      return real.withTenant(clientId, fn);
    },
  };
}

/** A transport that fails the test if ever invoked - the crash happens before `dispatch()` reaches the provider call, so `transport.send` must never fire. */
export function unreachableTransport(): { send: () => Promise<never> } {
  return {
    send: () => {
      throw new Error('unreachableTransport: transport.send must never be reached in this test');
    },
  };
}

export function makeReaperDeps(
  pool: TestPool,
  tenantDb: TenantDb,
  metrics: QueueMetricsHandles,
): ReaperDeps {
  return {
    pool,
    tenantDb,
    metrics,
    sink: createCountingNoOpRepairedSendSink(),
    graceSeconds: 30,
    limit: 500,
    rng: { random: () => 0 },
  };
}

export async function expireLease(pool: TestPool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [jobId],
  );
}
