import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { WARMUP_LADDER, type HealthBand, type Layers, type PacingLayer } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { updatePacingConfig } from '../../engine/pacing/config-service.js';
import { nextLocalMidnightMs } from '../../engine/pacing/retry-at.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { cleanupWaGroups, seedWaGroup } from './__tests__/groups-test-helpers.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  jobState,
  linkInstance,
  resetMinGap,
  runOneIteration,
} from './__tests__/send-test-helpers.js';

/**
 * send-guards.integration.test.ts (P24 groups-messaging, Unit U4a, step 6) -
 * mandatory tests 2 (tier-below-4 defers every group send) and 3 (health
 * band halves/zeroes the group cap). Tests 4-6 and 8 live in the sibling
 * `send-guards-content.integration.test.ts` / `send-guards-pricing.
 * integration.test.ts` (max-lines split of the original single file - same
 * idiom as `pipeline.integration.test.ts` / `pipeline-disposal-loop.
 * integration.test.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

// Real-time-based, NOT a hardcoded literal (lesson 2026-09-02
// "hardcoded-fake-clock-drifts-past-real-db-time", occurrences 1-3):
// `claim-jobs.sql`'s `next_attempt_at <= now()` predicate reads Postgres's
// REAL wall-clock `now()`, never this injected clock. A fixed-literal
// `CLOCK_MS` is only "now" at authoring time; once real time crosses it, a
// GROUP_DAILY_CAP deferral's resolved `next_attempt_at` (this clock's local
// midnight) lands in the DB's PAST instead of its future and the deferred
// group job becomes immediately re-claimable, starving the DM drain loop
// forever (exactly this test's prior failure mode). Deriving both the
// send-loop clock AND the expected deferral instant from `Date.now()` at
// test-run time keeps them mutually consistent regardless of calendar date.
const CLOCK_MS = Date.now();
// The deny-reason GROUP_DAILY_CAP effect's exact resolved retry instant -
// computed live via the SAME function `send-loop-claim-evaluation.ts` uses,
// from the SAME `CLOCK_MS` base, so it always sits in the DB's future.
const NEXT_LOCAL_MIDNIGHT_IST = new Date(nextLocalMidnightMs(CLOCK_MS, 'Asia/Kolkata'));

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-send-guards-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildGroupSendTestKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // The guard pipeline's duplicate-fanout check writes these on every
    // real send loop pass - `cleanupSendProbeClients` predates this suite's
    // content-guard traffic and does not know about them.
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group send pacing-tier guards (P24 groups-messaging, U4a)', () => {
  it('tier_below_4_yields_zero_group_sends_end_to_end', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    // Tier 3's own eff_group_daily_cap is 0 (WARMUP_LADDER) - simulate that
    // tier directly on the already-seeded row rather than re-seeding.
    await pool.query(
      'UPDATE instance_pacing_state SET eff_group_daily_cap = 0 WHERE instance_id = $1',
      [instanceId],
    );
    const groups = await Promise.all(
      [1, 2, 3].map(() =>
        seedWaGroup(pool, { clientId, instanceId, sendEnabled: true, participantCount: 5 }),
      ),
    );
    const groupResults = await Promise.all(
      groups.map((g) => enqueueVia(tenantDb, keyProvider, clientId, instanceId, g.groupJid)),
    );
    const dmResults = await Promise.all(
      [1, 2].map(() =>
        enqueueVia(
          tenantDb,
          keyProvider,
          clientId,
          instanceId,
          `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        ),
      ),
    );

    const beforeAttempts = await Promise.all(
      groupResults.map(async (r) => {
        const jobId = await jobIdForPublicId(pool, clientId, r.id);
        return jobState(pool, jobId);
      }),
    );

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.dm-1');
    transport.queueResolve(0, 'wamid.dm-2');

    // Drain until the two DMs are sent. `runOneIteration` returns `false`
    // both when nothing was claimable AND when a claimed job was denied and
    // requeued in the same pass (`claimAndReserve`'s "band-empty shape" -
    // see that module's own doc) - so this loop keeps trying (a claimed
    // group job's own `next_attempt_at` moves to midnight, so a LATER pass
    // naturally reaches the DMs instead) rather than stopping on the first
    // `false`, bounded by a fixed attempt cap since a real bug here would
    // otherwise spin forever instead of failing loudly.
    let dmSentCount = 0;
    for (let i = 0; i < 10 && dmSentCount < dmResults.length; i += 1) {
      await runOneIteration(tenantDb, pool, {
        clientId,
        instanceId,
        transport,
        clockMs: CLOCK_MS,
      });
      await resetMinGap(pool, instanceId);
      const sentCheck = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM message_jobs
           WHERE client_id = $1 AND instance_id = $2 AND status = 'sent'`,
        [clientId, instanceId],
      );
      dmSentCount = Number(sentCheck.rows[0]?.count ?? '0');
    }
    expect(dmSentCount).toBe(2);

    for (const [i, r] of groupResults.entries()) {
      const jobId = await jobIdForPublicId(pool, clientId, r.id);
      const state = await jobState(pool, jobId);
      expect(state.status).toBe('queued');
      expect(state.pacing_deny_reason).toBe('GROUP_DAILY_CAP');
      expect(state.attempts).toBe(beforeAttempts[i]!.attempts);
      expect(state.next_attempt_at.toISOString()).toBe(NEXT_LOCAL_MIDNIGHT_IST.toISOString());

      const attemptRows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM send_attempts WHERE message_job_id = $1`,
        [jobId],
      );
      expect(attemptRows.rows[0]?.count).toBe('0');
    }
  });

  it('group_cap_halves_in_watch_and_is_zero_in_degraded', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const tier = WARMUP_LADDER.find((t) => t.tier === 4)!;
    const systemProfile: PacingLayer = {
      dailyCap: 1000,
      hourlyCap: 200,
      newConvCap: 500,
      gapMinMs: 15_000,
      gapMaxMs: 600_000,
      coldRatioMax: 0.8,
      coldRatioFloor: 5,
      groupDailyCap: 50,
      window: { startLocal: '00:00:00', endLocal: '23:59:59' },
    };
    const warmupTier: PacingLayer = {
      dailyCap: tier.dailyCap,
      hourlyCap: tier.hourlyCap,
      newConvCap: tier.newConvCap,
      gapMinMs: tier.gapMinMs,
      gapMaxMs: tier.gapMaxMs,
      coldRatioMax: tier.coldRatioMax,
      groupDailyCap: tier.groupDailyCap,
    };

    async function setBand(band: HealthBand): Promise<number> {
      const layers: Layers = { systemProfile, warmupTier, healthBand: band };
      await updatePacingConfig({
        sql: pool,
        clientId,
        instanceId,
        kind: 'health_band',
        reason: 'test: group cap per health band',
        layers,
        clock: { now: () => CLOCK_MS },
      });
      const row = await pool.query<{ eff_group_daily_cap: number }>(
        `SELECT eff_group_daily_cap FROM instance_pacing_state WHERE instance_id = $1`,
        [instanceId],
      );
      return row.rows[0]!.eff_group_daily_cap;
    }

    expect(tier.groupDailyCap).toBe(10);
    expect(await setBand('watch')).toBe(5);
    expect(await setBand('degraded')).toBe(0);
    expect(await setBand('healthy')).toBe(10);
  });
});
