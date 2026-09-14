import { randomUUID } from 'node:crypto';
import type { BatchFrame } from '@wp/contracts';
import type { BatchPublisherPort, RelayMetricsPort } from '../../modules/events/relay-loop.js';

/**
 * relay-test-helpers.ts (P15 U4, step 5) - shared harness for
 * `roles/relay*.integration.test.ts`. Lives under `__tests__/` so the raw
 * `outbox_events` INSERTs below are covered by the same
 * tenant-scope-guard seed/cleanup exemption `crash-injector.ts`'s own header
 * documents - these rows are seeded directly (bypassing `emit()`) because
 * these tests are proving the RELAY's own claim/coalesce/publish/mark
 * behaviour, not `emit`'s (already proven in `emit.test.ts`/
 * `emit.integration.test.ts`).
 *
 * NOT a role entrypoint (see `../relay.integration.test.ts`'s own note on
 * `scripts/check-role-boot.ts`'s glob) - no `assertDbPreconditionsOrExit`
 * call here; that gate belongs to `roles/relay.ts`'s own `main()`.
 */

export interface TestPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  connect(): Promise<{
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }>;
    release(err?: unknown): void;
  }>;
}

export interface SeedOutboxRowInput {
  clientId: string;
  instanceId?: string | null;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  coalesceKey?: string | null;
  fanout: ('sse' | 'webhook')[];
  /** Overrides `created_at` for lag/backpressure/cleanup fixtures - defaults to `now()`. */
  createdAt?: Date;
  /** Overrides `published_at` directly (cleanup fixtures need already-published rows). */
  publishedAt?: Date | null;
}

/** Inserts one raw `outbox_events` row, bypassing `emit()` entirely (this suite proves the RELAY's own behaviour, not emit's). Returns the row's bigint id as a string. */
export async function seedOutboxRow(pool: TestPool, input: SeedOutboxRowInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events
       (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout, created_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9)
     RETURNING id`,
    [
      input.clientId,
      input.instanceId ?? null,
      input.type,
      input.entityId,
      JSON.stringify(input.payload),
      input.coalesceKey ?? null,
      input.fanout,
      input.createdAt ?? null,
      input.publishedAt ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('seedOutboxRow: no id returned');
  return id;
}

export async function cleanupOutboxRows(pool: TestPool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
}

/** Builds a `message.job.status_changed` seed input for one instance - the phase demo's own event family. */
export function jobStatusChangedSeed(
  clientId: string,
  instanceId: string,
  jobPublicId: string,
): SeedOutboxRowInput {
  return {
    clientId,
    instanceId,
    type: 'message.job.status_changed',
    entityId: jobPublicId,
    payload: { jobPublicId, instanceId, status: 'sent' },
    coalesceKey: `instance:${instanceId}:jobs`,
    fanout: ['sse'],
  };
}

export interface RecordingPublisher extends BatchPublisherPort {
  calls: { clientId: string; instanceId: string | null; frame: BatchFrame }[];
}

export function createRecordingPublisher(): RecordingPublisher {
  const calls: { clientId: string; instanceId: string | null; frame: BatchFrame }[] = [];
  return {
    calls,
    publishBatch(clientId, instanceId, frame) {
      calls.push({ clientId, instanceId, frame });
    },
  };
}

export function createNoOpMetrics(): RelayMetricsPort {
  return {
    setOutboxDepth: () => undefined,
    observePublishLagSeconds: () => undefined,
    incrementEventsPublished: () => undefined,
    incrementSseCoalesced: () => undefined,
    incrementDropped: () => undefined,
    incrementPoisoned: () => undefined,
  };
}

export interface RecordingMetricsState {
  droppedCalls: { topicClass: string; count: number }[];
  poisonedCalls: { topicClass: string; count: number }[];
  coalescedTotal: number;
  publishedByFanout: Record<'sse' | 'webhook', number>;
  lastDepth: number | undefined;
  /** Every `observePublishLagSeconds` draw this tick, in call order - see `relay-lag-metric.integration.test.ts`. */
  publishLagSecondsCalls: number[];
}

export interface RecordingMetrics extends RelayMetricsPort {
  state: RecordingMetricsState;
}

export function createRecordingMetrics(): RecordingMetrics {
  const state: RecordingMetricsState = {
    droppedCalls: [],
    poisonedCalls: [],
    coalescedTotal: 0,
    publishedByFanout: { sse: 0, webhook: 0 },
    lastDepth: undefined,
    publishLagSecondsCalls: [],
  };
  return {
    state,
    setOutboxDepth: (depth) => {
      state.lastDepth = depth;
    },
    observePublishLagSeconds: (seconds) => {
      state.publishLagSecondsCalls.push(seconds);
    },
    incrementEventsPublished: (fanout) => {
      state.publishedByFanout[fanout] += 1;
    },
    incrementSseCoalesced: (count) => {
      state.coalescedTotal += count;
    },
    incrementDropped: (topicClass, count) => {
      state.droppedCalls.push({ topicClass, count });
    },
    incrementPoisoned: (topicClass, count) => {
      state.poisonedCalls.push({ topicClass, count });
    },
  };
}

export function newClientId(): string {
  return randomUUID();
}

export function newInstanceId(): string {
  return randomUUID();
}
