import { createPool } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../platform/db/db-url.js';
import { drainOnce, DEFAULT_BACKPRESSURE_DEPTH_THRESHOLD } from '../modules/events/relay-loop.js';
import {
  cleanupOutboxRows,
  createNoOpMetrics,
  createRecordingMetrics,
  createRecordingPublisher,
  newClientId,
  newInstanceId,
  seedOutboxRow,
  type TestPool,
} from './__tests__/relay-test-helpers.js';

/**
 * roles/relay-backpressure.integration.test.ts (P15 U4, step 5) - ADR 0010's
 * backpressure policy and the NOTIFY-is-a-hint-only correctness proof, split
 * from `relay.integration.test.ts` for file-size (300-line cap, established
 * split idiom). `backpressureDepthThreshold` is INJECTABLE (default 50_000,
 * asserted directly below) so this suite never seeds 50,001 real rows.
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

describe('drainOnce - backpressure default threshold', () => {
  it('the_default_backpressure_depth_threshold_is_exactly_50000', () => {
    expect(DEFAULT_BACKPRESSURE_DEPTH_THRESHOLD).toBe(50_000);
  });
});

describe('drainOnce - backpressure drops only ephemeral topics', () => {
  it('backpressure_drops_only_ephemeral_topics', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // One row of every protected family, plus one ephemeral (droppable) row
    // and one webhook-fanned row. `chat.*` (also protected per
    // OUTBOX_EPHEMERAL_TOPICS's own exclusion list / topics.ts) has no
    // `realtimeEventSchema` member yet (a future P17 inbox event family -
    // see coalesce.ts's own doc comment) - `message.job.*` and
    // `instance.health_changed` below already exercise the "protected,
    // never dropped" behaviour end to end; `chat.*`'s exclusion is enforced
    // by the SAME `EPHEMERAL_TOPIC_SET.has(row.event_type)` membership check
    // relay-loop.ts uses for every other protected family, so no additional
    // per-family code path exists to test separately once its schema lands.
    const jobId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_protected',
      payload: { jobPublicId: 'job_protected', instanceId, status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs`,
      fanout: ['sse'],
    });
    const healthId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
    });
    const webhookId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'job.needs_user_action',
      entityId: 'job_webhook',
      payload: { jobPublicId: 'job_webhook', reason: 'unresolved_send' },
      coalesceKey: null,
      fanout: ['webhook'],
    });
    const ephemeralId = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.pacing_changed',
      entityId: instanceId,
      payload: { instanceId, band: 'NORMAL', tier: 1, effDailyCap: 100, configVersion: 1 },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
    });

    const publisher = createRecordingPublisher();
    const metrics = createRecordingMetrics();

    await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:00.000Z') },
      // Depth threshold injected as 0 so this small, seeded batch is
      // already "over" it - never seeding 50,001 real rows to exercise the
      // real production default (asserted separately above).
      backpressureDepthThreshold: 0,
    });

    const rows = await pool.query<{ id: string; published_at: Date | null }>(
      'SELECT id, published_at FROM outbox_events WHERE id = ANY($1)',
      [[jobId, healthId, webhookId, ephemeralId]],
    );
    const publishedAtById = new Map(rows.rows.map((row) => [row.id, row.published_at]));

    // Every protected row and the webhook row are marked published NORMALLY
    // (via the ordinary publish path, not dropped).
    for (const protectedId of [jobId, healthId, webhookId]) {
      expect(publishedAtById.get(protectedId)).not.toBeNull();
    }
    // The ephemeral row was also marked published (dropped rows ARE marked
    // published - they are durably resolved as "silently dropped", never
    // left to be reclaimed forever), but with NO frame ever emitted for it.
    expect(publishedAtById.get(ephemeralId)).not.toBeNull();

    // The protected job/health events (and the webhook row) each appear in a
    // real published frame or webhook-published increment; the ephemeral
    // one does not appear in ANY frame.
    const allFramedEntityIds = publisher.calls.flatMap((call) =>
      call.frame.events.map((event) => {
        if (event.type === 'message.job.status_changed') return event.jobPublicId;
        if (event.type === 'instance.health_changed') return event.instanceId;
        return 'other';
      }),
    );
    expect(allFramedEntityIds).not.toContain('other');
    expect(metrics.state.droppedCalls).toEqual([
      { topicClass: 'instance.pacing_changed', count: 1 },
    ]);
    expect(metrics.state.publishedByFanout.webhook).toBe(1);
  });
});

describe('drainOnce - NOTIFY is a hint only', () => {
  it('notify_silence_still_publishes_within_the_poll_floor', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const id = await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'instance.health_changed',
      entityId: instanceId,
      payload: { instanceId, healthState: 'connected', pauseReason: null, needsUserAction: false },
      coalesceKey: `instance:${instanceId}:state`,
      fanout: ['sse'],
    });

    // No LISTEN/NOTIFY wiring is used anywhere in this test - `drainOnce`
    // has no awareness of NOTIFY at all (see relay-loop.ts's own module doc:
    // "The relay treats NOTIFY purely as 'drain now'"), so simply calling it
    // directly (as the fixed poll tick would, with no notification ever
    // received) is the correctness proof: publication never depends on a
    // notify arriving.
    const publisher = createRecordingPublisher();
    const claimed = await drainOnce({
      pool,
      publisher,
      metrics: createNoOpMetrics(),
      clock: { now: () => new Date('2026-09-02T00:00:00.500Z') },
    });

    expect(claimed).toBe(1);
    expect(publisher.calls).toHaveLength(1);

    const row = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM outbox_events WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.published_at).not.toBeNull();
  });
});
