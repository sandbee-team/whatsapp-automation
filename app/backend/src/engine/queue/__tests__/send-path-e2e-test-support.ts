import { randomUUID } from 'node:crypto';
import type { TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import type { createDwrrSelector } from '@wp/domain';
import { claimOne } from '../../../modules/queue/queue.repo.js';
import type { createFakeTransport } from '../../../provider/__test-support__/fake-transport.js';
import { dispatch } from '../dispatch.js';
import { resolveAck, resolveFailure } from '../result.js';
import { bindQueueMetrics } from '../metrics.js';
import type { SendLoopDeps } from '../send-loop.js';
import type { TestPool } from './queue-send-test-helpers.js';

/**
 * send-path-e2e-test-support.ts (P11 Unit U6b) - shared, non-test fixture
 * machinery for the three `send-path*.e2e.integration.test.ts` siblings
 * (split across files for the 300-line cap; this module holds what all
 * three need so none of them re-derives the `SendLoopDeps` wiring). Lives
 * under `__tests__/` alongside `queue-send-test-helpers.ts`, same
 * tenant-scope-guard exemption convention.
 */

export const FAST_SEND_TIMEOUT_MS = 200;
export const FAST_HEARTBEAT_INTERVAL_MS = 50;

export async function readMaxAttemptsUsing(pool: TestPool, jobId: string): Promise<number> {
  const row = await pool.query<{ max_attempts: number }>(
    'SELECT max_attempts FROM message_jobs WHERE id = $1',
    [jobId],
  );
  return row.rows[0]?.max_attempts ?? 5;
}

interface DeliveryEventRow {
  event_type: string;
}

/** Every `delivery_events` row for `clientId`, in true write order (`ORDER BY id`, the table's own monotonic PK half). */
export async function orderedDeliveryEvents(pool: TestPool, clientId: string): Promise<string[]> {
  const result = await pool.query<DeliveryEventRow>(
    'SELECT event_type FROM delivery_events WHERE client_id = $1 ORDER BY id',
    [clientId],
  );
  return result.rows.map((row) => row.event_type);
}

/**
 * Builds a full `SendLoopDeps` bag with a fake transport - the same wiring
 * `wake.integration.test.ts` uses, minus production's not-ready
 * `getSendSocket` gap (U5's own documented, expected-for-this-phase
 * limitation).
 */
export function sendLoopDepsUsing(
  pool: TestPool,
  tenantDb: TenantDb,
  clientId: string,
  instanceId: string,
  fence: number,
  transport: ReturnType<typeof createFakeTransport>,
  dwrr: ReturnType<typeof createDwrrSelector>,
  now: () => number = () => Date.now(),
): SendLoopDeps {
  const registry = createMetricsRegistry();
  const metrics = bindQueueMetrics(registry);
  return {
    clientId,
    instanceId,
    workerId: 'worker-e2e',
    fence,
    claimOne,
    dispatch: (input, deps) => dispatch(input, deps as never),
    resolveAck: (input, deps) => resolveAck(input, deps as never),
    resolveFailure: (input, deps) => resolveFailure(input, deps as never),
    readMaxAttempts: (jobId) => readMaxAttemptsUsing(pool, jobId),
    metrics,
    rng: { random: () => 0.5 },
    clock: { now },
    dwrr,
    ctx: { clientId, sql: pool },
    dispatchDeps: {
      tenantDb,
      transport,
      clock: { now },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    },
    resultDeps: { tenantDb, rng: { random: () => 0.5 } },
  };
}

/** Inserts a SECOND `whatsapp_instances` + `instance_lease_state` row for an already-seeded `clientId` (`seedSendTenant` only ever creates one). */
export async function seedSecondInstance(
  pool: TestPool,
  clientId: string,
  options: { healthState?: string; fence?: number } = {},
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'send-probe-2', $3, 0)`,
    [instanceId, clientId, options.healthState ?? 'connected'],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, options.fence ?? 1],
  );
  return instanceId;
}
