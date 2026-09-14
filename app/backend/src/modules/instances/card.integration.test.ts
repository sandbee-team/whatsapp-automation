import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { INSTANCE_CARD_COPY } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveRedisUrl, createRedis } from '../../platform/redis.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  seedQueuedJobs,
  seedSentNoiseJobs,
  seedOtherInstanceNoise,
  fetchQueuedCreatedIndexChildNames,
} from './__tests__/card-test-fixtures.js';
import { readInstanceCard } from './card.service.js';

/**
 * card.integration.test.ts (P17 Unit U4, step 7) - `readInstanceCard`
 * against real Postgres + Redis: the bounded queue-depth probe caps at
 * 10,000+, the oldest-queued-age probe reads the new partial index, a
 * paused instance reports no countdown, and a parked instance renders the
 * verbatim parked copy. Every EXPLAIN assertion runs inside a
 * ROLLBACK-only transaction, same idiom as `db/tests/claim-plan.test.ts`.
 * Seed helpers live in `__tests__/card-test-fixtures.ts` (max-lines split).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'card-test' });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
  // Refreshes statistics after a large-fixture test deletes its rows, so a
  // LATER test's own EXPLAIN never inherits a stale row-count estimate from
  // rows that no longer exist.
  await pool.query('ANALYZE message_jobs');
});

describe('readInstanceCard (P17 Unit U4, real Postgres)', () => {
  it('queue_depth_is_bounded_and_reports_ten_thousand_plus', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await seedQueuedJobs(pool, clientId, instanceId, 10_500);
    // 40 x 3000 = 120,000 other-tenant rows sharing this partition, so the
    // probed instance's 10,500 rows are a SELECTIVE ~8% slice of the
    // partition rather than dominating it - re-derived 2026-09-05 after
    // the monthly partition rollover made the September partition
    // otherwise near-empty and the planner's genuinely-cheaper choice
    // became Seq Scan (15 x 3000 was sized for the August fixture shape
    // and no longer clears the threshold; see the lesson file cited in
    // seedOtherInstanceNoise's own doc comment).
    await seedOtherInstanceNoise(pool, clientId, 40, 3000);
    // Re-establish fresh statistics for THIS fixture's own shape - a stale
    // ANALYZE from an earlier test's now-deleted rows must never leak a
    // different plan into this assertion (same discipline
    // db/tests/claim-plan.test.ts's own afterEach re-ANALYZE documents).
    await pool.query('ANALYZE message_jobs');

    const card = await readInstanceCard({ tenantDb, redis, env: 'test' }, { clientId, instanceId });

    expect(card.queueDepth).toBe(10_000);
    expect(card.queueDepthCapped).toBe(true);

    // EXPLAIN assertion for the bounded count - migration 0049's own header
    // (probe (a)) documents `message_jobs_claim_idx (client_id, instance_id,
    // priority_rank, next_attempt_at, id) WHERE status = 'queued'` as ONE
    // eligible index-only path; with enough OTHER-instance rows sharing the
    // partition (seedOtherInstanceNoise above) the planner may instead pick
    // the new `message_jobs_queued_probe_idx` partial index via a Bitmap
    // scan - both are real, non-Seq-Scan, index-served plans against the
    // partition that actually holds this fixture's rows. Other, empty
    // sibling partitions correctly plan a cheap Seq Scan over zero rows
    // (same documented planner behavior as db/tests/claim-plan.test.ts -
    // never a defect in this query), so the assertion below targets only the
    // partition with real rows, never a blanket "no Seq Scan anywhere".
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { loadQuery, bindQueryParams } = await import('@wp/db');
      const query = await loadQuery('instance-card-queue-depth');
      const params = bindQueryParams(query, { client_id: clientId, instance_id: instanceId });
      const explain = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${query.text}`,
        params,
      );
      const plan = explain.rows.map((row) => row['QUERY PLAN']).join('\n');
      const lines = plan.split('\n');
      // The partition holding this fixture's 10,500+ rows must be scanned
      // via a real index path (Index/Index Only/Bitmap), never a Seq Scan -
      // found by its distinctive non-zero `rows=` estimate on a SCAN node
      // line specifically (an empty sibling partition's Seq Scan line always
      // shows `rows=1` - the planner's default single-row stand-in for zero
      // real rows, never this fixture's own count).
      const populatedScanLine = lines.find(
        (line) => /Scan.*\(cost=/.test(line) && !/\brows=1\s+width=/.test(line),
      );
      expect(populatedScanLine, plan).toBeDefined();
      expect(populatedScanLine, plan).toMatch(/Index (Only )?Scan|Bitmap (Heap|Index) Scan/);
      expect(populatedScanLine, plan).not.toMatch(/Seq Scan/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 30_000);

  it('oldest_queued_age_matches_the_oldest_queued_job', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const oldestAt = new Date(Date.now() - 60_000);
    await seedQueuedJobs(pool, clientId, instanceId, 3, (i) =>
      i === 0 ? oldestAt : new Date(Date.now() - 10_000 + i),
    );
    // Many NEWER, non-queued rows - see seedSentNoiseJobs's own doc comment
    // for why this is needed to get a genuine cost-based index preference.
    await seedSentNoiseJobs(pool, clientId, instanceId, 2000);
    await pool.query('ANALYZE message_jobs');

    const card = await readInstanceCard({ tenantDb, redis, env: 'test' }, { clientId, instanceId });

    expect(card.oldestQueuedAgeSeconds).not.toBeNull();
    expect(Math.abs((card.oldestQueuedAgeSeconds ?? 0) - 60)).toBeLessThan(2);

    // EXPLAIN assertion: message_jobs_queued_probe_idx (client_id,
    // instance_id, created_at) WHERE status = 'queued' (migration 0050) is
    // an ELIGIBLE index for this probe's shape. `enable_seqscan off` forces
    // the plan through a real index path (same "force the eligibility comparison"
    // idiom migration 0049's own header describes for a near-empty dev DB) -
    // proving the new partial index is real and usable, without depending on
    // ambient row-count-driven cost comparisons this test does not control.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { loadQuery, bindQueryParams } = await import('@wp/db');
      const query = await loadQuery('instance-card-oldest-queued');
      const params = bindQueryParams(query, { client_id: clientId, instance_id: instanceId });
      const explain = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${query.text}`,
        params,
      );
      const plan = explain.rows.map((row) => row['QUERY PLAN']).join('\n');
      const childIndexNames = await fetchQueuedCreatedIndexChildNames(pool);
      expect(childIndexNames.length).toBeGreaterThan(0);
      const usedTheNewPartialIndex = childIndexNames.some((name) => plan.includes(name));
      expect(usedTheNewPartialIndex, plan).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 30_000);

  it('a_paused_instance_reports_no_countdown_and_a_needs_user_action_reason', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {
      healthState: 'paused',
    });
    await pool.query(
      `UPDATE whatsapp_instances SET
          needs_user_action = true, user_action_reason = 'health_critical', pause_reason = 'health_critical'
        WHERE id = $1 AND client_id = $2`,
      [instanceId, clientId],
    );
    await seedQueuedJobs(pool, clientId, instanceId, 2);

    const card = await readInstanceCard({ tenantDb, redis, env: 'test' }, { clientId, instanceId });

    expect(card.nextSendEarliestAt).toBeNull();
    expect(card.needsUserAction).toBe(true);
    expect(card.userActionReason).toBe('health_critical');
    expect(card.queueDepth).toBe(2);
  });

  it('a_cache_hit_within_5s_still_succeeds_with_the_same_queue_numbers_and_a_fresh_serverNow', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await seedQueuedJobs(pool, clientId, instanceId, 2);

    const ctx = { tenantDb, redis, env: 'test' };
    const first = await readInstanceCard(ctx, { clientId, instanceId });
    // Second read within the 5s TTL - a cache HIT (P17 fix round F3: this
    // used to throw because the cached blob carried a `serverNow` string
    // JSON.parse can never revive as a Date).
    const second = await readInstanceCard(ctx, { clientId, instanceId });

    expect(second.queueDepth).toBe(first.queueDepth);
    expect(second.oldestQueuedAgeSeconds).toBe(first.oldestQueuedAgeSeconds);
    expect(() => new Date(second.serverNow).toISOString()).not.toThrow();
    expect(new Date(second.serverNow).getTime()).toBeGreaterThanOrEqual(
      new Date(first.serverNow).getTime(),
    );
  });

  it('a_parked_instance_renders_the_verbatim_parked_copy', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query(
      `UPDATE whatsapp_instances SET desired_state = 'offline' WHERE id = $1 AND client_id = $2`,
      [instanceId, clientId],
    );

    const card = await readInstanceCard({ tenantDb, redis, env: 'test' }, { clientId, instanceId });

    expect(card.parked).toBe(true);
    expect(INSTANCE_CARD_COPY.parked).toBe(
      'Parked — not connected. This number is not receiving messages while parked. Messages ' +
        'people send you during this time may not appear after you reconnect. Queued messages ' +
        'are safe and will send when you reconnect.',
    );
  });
});
