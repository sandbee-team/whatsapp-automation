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
 * roles/relay-lag-metric.integration.test.ts (P15 C2 hardening pass) -
 * `drainOnce`'s publish-lag observation (`RelayMetricsPort.
 * observePublishLagSeconds`) against real Postgres. Sibling of
 * `relay.integration.test.ts` (max-lines split, not a behavioural boundary -
 * that file sits at 276/300 already).
 *
 * REGRESSION: `db/queries/claim-outbox.sql` did not select `created_at`
 * even though `relay-loop.ts`'s `ClaimedRow`/`toOutboxRow`/the lag
 * computation all read `row.created_at`. At runtime the column was
 * `undefined`, so `oldestCreatedAt` (folded via `row.created_at < oldest`)
 * never became anything but `undefined` and `observePublishLagSeconds` was
 * silently NEVER called - no throw, no test failure, because every existing
 * caller stubbed the metric as a no-op. Fixed by adding `created_at` to the
 * claim SELECT list; this test asserts the metric fires with the EXACT lag
 * value (never a bounds-only assertion), per the mechanical convention on
 * units/quantities.
 *
 * NOT a role entrypoint: `scripts/check-role-boot.ts`'s glob also matches
 * sibling test files directly under `roles/` - this file calls `drainOnce`
 * directly and never calls `assertDbPreconditionsOrExit` (that gate belongs
 * to `roles/relay.ts`'s own `main()`).
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

describe('drainOnce - publish lag metric', () => {
  it('observes_the_exact_lag_between_the_oldest_claimed_rows_created_at_and_the_clock', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    const createdAt = new Date('2026-09-02T00:00:00.000Z');
    await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_lag',
      payload: { jobPublicId: 'job_lag', instanceId, status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:lag`,
      fanout: ['sse'],
      createdAt,
    });

    const publisher = createRecordingPublisher();
    const metrics = createRecordingMetrics();

    // Clock is exactly 7.25s after the seeded row's created_at.
    const claimed = await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:07.250Z') },
    });

    expect(claimed).toBe(1);
    expect(metrics.state.publishLagSecondsCalls).toEqual([7.25]);
  });

  it('the_lag_is_measured_from_the_oldest_row_in_a_multi_row_claim_not_the_newest', async () => {
    const clientId = newClientId();
    const instanceId = newInstanceId();
    seededClientIds.push(clientId);

    // Two distinct coalesce keys so both rows survive coalescing as
    // separate winners - the lag must reflect the OLDER of the two.
    await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_old',
      payload: { jobPublicId: 'job_old', instanceId, status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:old`,
      fanout: ['sse'],
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    await seedOutboxRow(pool, {
      clientId,
      instanceId,
      type: 'message.job.status_changed',
      entityId: 'job_new',
      payload: { jobPublicId: 'job_new', instanceId, status: 'sent' },
      coalesceKey: `instance:${instanceId}:jobs:new`,
      fanout: ['sse'],
      createdAt: new Date('2026-09-02T00:00:09.000Z'),
    });

    const publisher = createRecordingPublisher();
    const metrics = createRecordingMetrics();

    const claimed = await drainOnce({
      pool,
      publisher,
      metrics,
      clock: { now: () => new Date('2026-09-02T00:00:10.000Z') },
    });

    expect(claimed).toBe(2);
    // 10s clock - 0s oldest created_at = 10s exactly (never the 1s the
    // newest row alone would have produced).
    expect(metrics.state.publishLagSecondsCalls).toEqual([10]);
  });
});
