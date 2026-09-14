import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../platform/db/db-url.js';
import { drainOnce } from '../modules/events/relay-loop.js';
import {
  cleanupOutboxRows,
  createRecordingMetrics,
  createRecordingPublisher,
  newClientId,
  newInstanceId,
  seedOutboxRow,
  type TestPool,
} from './__tests__/relay-test-helpers.js';

/**
 * roles/relay-poison-row.integration.test.ts (P15 C1 FIX F2 / CRIT-3) - a
 * malformed `outbox_events` row (an sse event whose stored payload no longer
 * validates against `realtimeEventSchema` - here, `message.job.status_changed`
 * missing its required `instanceId` field) must never wedge the tick for
 * every OTHER row: a valid row claimed in the SAME tick still publishes, and
 * the malformed row is isolated (attempts bumped, then quarantined past the
 * ceiling) rather than throwing and rolling back the whole transaction.
 *
 * NOT a role entrypoint (see `relay.integration.test.ts`'s own note on
 * `scripts/check-role-boot.ts`'s glob) - no `assertDbPreconditionsOrExit`
 * call here; that gate belongs to `roles/relay.ts`'s own `main()`.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-tests',
}) as unknown as TestPool;

afterAll(async () => {
  await (pool as unknown as { end: () => Promise<void> }).end();
});

let seededClientIds: string[] = [];

afterEach(async () => {
  await cleanupOutboxRows(pool, seededClientIds);
  seededClientIds = [];
});

describe('drainOnce - a malformed row is isolated, never wedging the tick', () => {
  it('a_valid_row_still_publishes_in_the_same_tick_as_a_malformed_row', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // Malformed: message.job.status_changed with NO instanceId (a required
    // field) - assertIdsOnly only rejects UNKNOWN keys, never MISSING ones,
    // so a row shaped like this can exist in outbox_events.payload without
    // ever tripping emit()'s own gate (e.g. written by some other path, or
    // a future schema-narrowing migration on an already-stored row).
    const malformedId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_malformed',
      payload: { jobPublicId: 'job_malformed', status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:malformed`,
      fanout: ['sse'],
    });
    const validId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_valid',
      payload: { jobPublicId: 'job_valid', instanceId, status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:valid`,
      fanout: ['sse'],
    });

    const publisher = createRecordingPublisher();
    const metrics = createRecordingMetrics();

    const claimed = await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:00.000Z') },
    });

    expect(claimed).toBe(2);

    // The valid row published normally.
    const framedJobIds = publisher.calls.flatMap((call) =>
      call.frame.events.map((event) =>
        event.type === 'message.job.status_changed' ? event.jobPublicId : 'other',
      ),
    );
    expect(framedJobIds).toContain('job_valid');
    expect(framedJobIds).not.toContain('job_malformed');

    const validRow = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_events WHERE id = $1',
      [validId],
    );
    expect(validRow.rows[0]?.published_at).not.toBeNull();

    // The malformed row is left UNPUBLISHED with attempts bumped to 1 - not
    // quarantined yet (below POISON_ATTEMPT_CEILING), and never threw/rolled
    // back the transaction the valid row's publish ran in.
    const malformedRow = await pool.query<{ published_at: Date | null; attempts: number }>(
      'SELECT published_at, attempts FROM outbox_events WHERE id = $1',
      [malformedId],
    );
    expect(malformedRow.rows[0]?.published_at).toBeNull();
    expect(malformedRow.rows[0]?.attempts).toBe(1);
    expect(metrics.state.poisonedCalls).toEqual([]);
  });

  it('a_malformed_row_is_quarantined_after_the_attempt_ceiling_and_the_counter_increments', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const malformedId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_malformed_ceiling',
      payload: { jobPublicId: 'job_malformed_ceiling', status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:malformed_ceiling`,
      fanout: ['sse'],
    });

    const publisher = createRecordingPublisher();
    const clock = { now: () => new Date('2026-09-02T00:00:00.000Z') };

    // POISON_ATTEMPT_CEILING is 5 - four ticks bump attempts to 4 (still
    // unpublished, still reclaimed), the fifth tick crosses the ceiling and
    // quarantines it.
    for (let tick = 0; tick < 4; tick += 1) {
      const metrics = createRecordingMetrics();
      // Sequential ticks are the point here (reclaim ordering across
      // repeated ticks), not a perf-sensitive loop.
      const claimed = await drainOnce({ pool, publisher, metrics, clock });
      expect(claimed).toBe(1);
      expect(metrics.state.poisonedCalls).toEqual([]);
    }

    const beforeFinalTick = await pool.query<{ attempts: number; published_at: Date | null }>(
      'SELECT attempts, published_at FROM outbox_events WHERE id = $1',
      [malformedId],
    );
    expect(beforeFinalTick.rows[0]?.attempts).toBe(4);
    expect(beforeFinalTick.rows[0]?.published_at).toBeNull();

    const finalMetrics = createRecordingMetrics();
    const finalClaimed = await drainOnce({ pool, publisher, metrics: finalMetrics, clock });
    expect(finalClaimed).toBe(1);

    expect(finalMetrics.state.poisonedCalls).toEqual([
      { topicClass: 'message.job.status_changed', count: 1 },
    ]);

    const afterQuarantine = await pool.query<{
      attempts: number;
      published_at: Date | null;
      suppressed_by: string | null;
    }>('SELECT attempts, published_at, suppressed_by FROM outbox_events WHERE id = $1', [
      malformedId,
    ]);
    expect(afterQuarantine.rows[0]?.attempts).toBe(5);
    expect(afterQuarantine.rows[0]?.published_at).not.toBeNull();
    expect(afterQuarantine.rows[0]?.suppressed_by).toBe('0');

    // Quarantined - never reclaimed again (published_at is now set).
    const reclaimMetrics = createRecordingMetrics();
    const reclaimClaimed = await drainOnce({
      pool,
      publisher,
      metrics: reclaimMetrics,
      clock,
    });
    const reclaimedRows = await pool.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE id = $1 AND published_at IS NULL',
      [malformedId],
    );
    expect(reclaimedRows.rows).toHaveLength(0);
    void reclaimClaimed;
  });
});
