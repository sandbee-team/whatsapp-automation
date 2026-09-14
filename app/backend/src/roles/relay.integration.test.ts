import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../platform/db/db-url.js';
import { drainOnce, type BatchPublisherPort } from '../modules/events/relay-loop.js';
import {
  cleanupOutboxRows,
  createNoOpMetrics,
  createRecordingMetrics,
  createRecordingPublisher,
  jobStatusChangedSeed,
  newClientId,
  newInstanceId,
  seedOutboxRow,
  type TestPool,
} from './__tests__/relay-test-helpers.js';

/**
 * roles/relay.integration.test.ts (P15 U4, step 5) - real-Postgres proof of
 * `drainOnce`'s core drain/coalesce/exactly-once/crash-safety behaviour.
 * Runs as the plain (BYPASSRLS) dev/test pool role directly - `drainOnce`
 * itself issues `SET LOCAL ROLE wp_relay` on its OWN pinned connection
 * (see `relay-loop.ts`'s `withRelayRole`), so this is already a real
 * role-scoped proof, not a vacuous superuser one (the lesson from
 * `.memory/lessons/2026-08-31-role-scoped-proof-tests-mandatory.md`).
 *
 * A fake, injected `clock` is used throughout (never real wall-clock
 * assertions) - see `relay-loop.ts`'s `RelayLoopDeps.clock`.
 *
 * NOT a role entrypoint: `scripts/check-role-boot.ts`'s glob is
 * `app/backend/src/roles/**\/*.ts`, which also matches sibling test files
 * (no prior role had a `.integration.test.ts` living directly under
 * `roles/` before this unit) - this file calls `drainOnce` directly, never
 * `assertDbPreconditionsOrExit` (that gate belongs to `roles/relay.ts`'s
 * own `main()`, exercised structurally, not per-test).
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

describe('drainOnce - the phase demo', () => {
  it('five_hundred_job_events_for_one_instance_produce_at_most_two_sse_frames_per_second', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    for (let i = 0; i < 500; i += 1) {
      await seedOutboxRow(pool, jobStatusChangedSeed(clientId, instanceId, `job_${String(i)}`));
    }

    const publisher = createRecordingPublisher();
    const metrics = createRecordingMetrics();

    // Simulates 1 second of real relay operation as TWO 500ms ticks (ADR
    // 0010: "Tick 500 ms") - the claim is bounded at 500 rows/tick, so all
    // 500 seeded rows are claimed in the FIRST tick; the second tick is a
    // legitimate no-op (verbatim measured output is what the evidence file
    // captures).
    const firstTickClaimed = await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:00.500Z') },
    });
    const secondTickClaimed = await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:01.000Z') },
    });

    expect(firstTickClaimed).toBe(500);
    expect(secondTickClaimed).toBe(0);

    // <= 2 frames/s per instance: one coalesced batch frame per tick that
    // actually claimed rows for this (client, instance) - here exactly 1,
    // well within the ceiling.
    const framesForInstance = publisher.calls.filter(
      (call) => call.clientId === clientId && call.instanceId === instanceId,
    );
    expect(framesForInstance).toHaveLength(1);
    expect(framesForInstance[0]?.frame.events).toHaveLength(1);

    // wp_sse_coalesced_total accounts for every suppressed row: 499 losers
    // folded into the 1 winner.
    expect(metrics.state.coalescedTotal).toBe(499);

    const remaining = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox_events WHERE client_id = $1 AND published_at IS NULL',
      [clientId],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });
});

describe('drainOnce - newest-wins coalescing', () => {
  it('the_last_frame_carries_the_newest_state_for_every_coalesce_key', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        await seedOutboxRow(pool, jobStatusChangedSeed(clientId, instanceId, 'job_same_key')),
      );
    }

    const publisher = createRecordingPublisher();
    await drainOnce({
      pool,
      publisher,
      metrics: createNoOpMetrics(),
      clock: { now: () => new Date('2026-09-02T00:00:00.000Z') },
    });

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.frame.events).toHaveLength(1);

    const rows = await pool.query<{
      id: string;
      published_at: Date | null;
      suppressed_by: string | null;
    }>('SELECT id, published_at, suppressed_by FROM outbox_events WHERE id = ANY($1) ORDER BY id', [
      ids,
    ]);
    const winnerId = ids[ids.length - 1];
    for (const row of rows.rows) {
      expect(row.published_at).not.toBeNull();
      if (row.id === winnerId) {
        expect(row.suppressed_by).toBeNull();
      } else {
        expect(row.suppressed_by).toBe(winnerId);
      }
    }
  });
});

describe('drainOnce - exactly-once across concurrent relay processes', () => {
  it('two_relay_processes_publish_each_event_exactly_once', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const ids: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      // Distinct coalesce keys (one per job) so every row is its own
      // winner - this test is about CLAIM exclusivity (SKIP LOCKED), not
      // coalescing.
      ids.push(
        await seedOutboxRow(pool, {
          clientId,
          instanceId,
          type: 'message.job.status_changed',
          entityId: `job_${String(i)}`,
          payload: { jobPublicId: `job_${String(i)}`, instanceId, status: 'sent' },
          coalesceKey: `instance:${instanceId}:jobs:${String(i)}`,
          fanout: ['sse'],
        }),
      );
    }

    const publisherA = createRecordingPublisher();
    const publisherB = createRecordingPublisher();

    // Two "relay processes" draining concurrently - each drainOnce call
    // claims via `FOR UPDATE SKIP LOCKED` inside its own transaction, so
    // running them truly concurrently (Promise.all) is the real proof: a
    // sequential pair would trivially never collide.
    const clock = { now: () => new Date('2026-09-02T00:00:00.000Z') };
    const [claimedA, claimedB] = await Promise.all([
      drainOnce({ pool, publisher: publisherA, metrics: createNoOpMetrics(), clock, limit: 500 }),
      drainOnce({ pool, publisher: publisherB, metrics: createNoOpMetrics(), clock, limit: 500 }),
    ]);

    expect(claimedA + claimedB).toBe(1000);

    // Every row was claimed by EXACTLY ONE of the two concurrent drains -
    // `FOR UPDATE SKIP LOCKED` means the two claim sets are disjoint by
    // construction; the DB's own `published_at`/`suppressed_by` state is the
    // ground truth (frame events are intentionally truncated at 25/tick per
    // group - see coalescer.ts - so counting frame events here would
    // conflate "coalesced/truncated" with "double-processed", a different
    // question this test does not ask).
    const rows = await pool.query<{
      id: string;
      published_at: Date | null;
      suppressed_by: string | null;
    }>('SELECT id, published_at, suppressed_by FROM outbox_events WHERE id = ANY($1)', [ids]);
    expect(rows.rows).toHaveLength(1000);
    for (const row of rows.rows) {
      expect(row.published_at).not.toBeNull();
      // Every coalesce_key was unique per row, so no row should ever be
      // suppressed by another - each is its own winner.
      expect(row.suppressed_by).toBeNull();
    }

    const unpublished = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox_events WHERE id = ANY($1) AND published_at IS NULL',
      [ids],
    );
    expect(unpublished.rows[0]?.count).toBe('0');
  });
});

describe('drainOnce - crash safety', () => {
  it('a_crash_between_dispatch_and_mark_republishes_and_the_receiver_dedupes', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const id = await seedOutboxRow(pool, jobStatusChangedSeed(clientId, instanceId, 'job_crash'));

    // A publisher that throws AFTER recording the call, simulating a
    // process crash between "dispatched the frame" and "marked published"
    // - the transaction rolls back, so the row's `published_at` stays NULL.
    const recorder = createRecordingPublisher();
    const crashingPublisher: BatchPublisherPort = {
      publishBatch: (clientId2, instanceId2, frame) => {
        recorder.publishBatch(clientId2, instanceId2, frame);
        throw new Error('injected crash: process died after publish, before mark-published');
      },
    };

    await expect(
      drainOnce({
        pool,
        publisher: crashingPublisher,
        metrics: createNoOpMetrics(),
        clock: { now: () => new Date('2026-09-02T00:00:00.000Z') },
      }),
    ).rejects.toThrow('injected crash');

    expect(recorder.calls).toHaveLength(1);

    const afterCrash = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(afterCrash.rows[0]?.published_at).toBeNull();

    // Next tick reclaims and republishes the SAME event identity (same row
    // id, same coalesce_key/entity_id) - never lost, never a new identity.
    const publisher = createRecordingPublisher();
    const claimed = await drainOnce({
      pool,
      publisher,
      metrics: createNoOpMetrics(),
      clock: { now: () => new Date('2026-09-02T00:00:01.000Z') },
    });
    expect(claimed).toBe(1);
    expect(publisher.calls).toHaveLength(1);
    const republished = publisher.calls[0]?.frame.events[0];
    expect(republished?.type === 'message.job.status_changed' && republished.jobPublicId).toBe(
      'job_crash',
    );

    const afterRepublish = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(afterRepublish.rows[0]?.published_at).not.toBeNull();
  });
});
