import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';
import { onConnectionUpdate, onSendOutcome, type FastLaneCtx } from './fast-lane.js';
import { applyHardSignalPause, type HardSignalPauseInput } from './hard-signal-pause.js';
import { humanResume } from './human-resume.js';

/**
 * hard-signal-pause-idempotency.integration.test.ts (C2 edge-case hardening,
 * 2026-09-03) - real Postgres. Targets gaps NOT covered by
 * `fast-lane.integration.test.ts` / `evaluator-atomicity.integration.test.ts`:
 *
 *  - replay of an already-applied hard-signal pause (duplicate 403 disconnect
 *    events, or a duplicate direct `applyHardSignalPause` call with the exact
 *    same `pauseReason`) must be a clean idempotent no-op: `paused: false`,
 *    and NOT a second `pacing_events`/`audit_logs`/outbox row (module doc's
 *    own claim, previously unproven).
 *  - two sequential resume-then-pause / pause-then-resume orderings on the
 *    same instance leave the DB in the state the LAST conditional write
 *    actually produced - never a state that satisfies neither statement's
 *    own postcondition (asserted via DB state, never a sampled race count).
 *  - a `rate_limited` retry storm (50 fast-lane calls in one synchronous
 *    pass) produces exactly ONE band-forcing write, not 50 - the fast-lane's
 *    own re-read-then-rank-compare guard is what bounds this, not any
 *    caller-side dedupe.
 *  - duplicate concurrent human-resume calls on the same paused instance:
 *    at most one reports `resumed: true`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'hard-signal-pause-idempotency-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_health_samples WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    // P17 U6 (step 5) - applyHardSignalPause now also writes a notifications
    // row; must be cleaned up like every other write path this suite seeds.
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

function baseHardSignalInput(
  clientId: string,
  instanceId: string,
): Omit<HardSignalPauseInput, 'pauseReason'> {
  return {
    clientId,
    instanceId,
    evidence: {},
    effectiveLimits: {},
    warmupTier: 1,
    accountAgeDays: 10,
    sendHistory30d: {},
    band: 'critical',
  };
}

describe('hard-signal-pause idempotency and ordering (real Postgres)', () => {
  it('a_second_applyHardSignalPause_call_with_the_same_reason_is_a_clean_no_op', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    const first = await tenantDb.withTenant(clientId, (tx) =>
      applyHardSignalPause(tx, {
        ...baseHardSignalInput(clientId, instanceId),
        pauseReason: 'health_critical',
      }),
    );
    expect(first.paused).toBe(true);

    const second = await tenantDb.withTenant(clientId, (tx) =>
      applyHardSignalPause(tx, {
        ...baseHardSignalInput(clientId, instanceId),
        pauseReason: 'health_critical',
      }),
    );
    expect(second.paused).toBe(false);

    const pauseRows = await pool.query(
      `SELECT id FROM pacing_events WHERE client_id = $1 AND instance_id = $2 AND kind = 'hard_signal_pause'`,
      [clientId, instanceId],
    );
    expect(pauseRows.rows).toHaveLength(1);

    const auditRows = await pool.query(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'instance.paused'`,
      [clientId, instanceId],
    );
    expect(auditRows.rows).toHaveLength(1);

    const outboxRows = await pool.query(
      `SELECT id FROM outbox_events WHERE client_id = $1 AND instance_id = $2 AND event_type = 'instance.paused'`,
      [clientId, instanceId],
    );
    expect(outboxRows.rows).toHaveLength(1);

    // P17 U6 (step 5) - exactly ONE `instance_paused` notification, never a
    // second one on the no-op replay (the mandatory-notify half of this same
    // idempotency proof).
    const notificationRows = await pool.query<{ kind: string; requires_user_action: boolean }>(
      `SELECT kind, requires_user_action FROM notifications WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('instance_paused');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(true);
  });

  it('duplicate_403_disconnect_events_through_the_fast_lane_pause_exactly_once', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    const results: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await tenantDb.withTenant(clientId, (tx) => {
        const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
        return onConnectionUpdate(ctx, { instanceId, disconnectCode: 403 });
      });
      results.push(outcome.paused);
    }

    // Exactly one of the three duplicate 403 events actually applies the
    // pause - core invariant 3 (idempotency at the storage layer).
    expect(results).toEqual([true, false, false]);

    const pauseRows = await pool.query(
      `SELECT id FROM pacing_events WHERE client_id = $1 AND instance_id = $2 AND kind = 'hard_signal_pause'`,
      [clientId, instanceId],
    );
    expect(pauseRows.rows).toHaveLength(1);
  });

  it('a_rate_limited_retry_storm_forces_the_band_exactly_once', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      healthState: 'connected',
      healthBand: 'healthy',
    });

    const forcedResults: boolean[] = [];
    for (let i = 0; i < 50; i += 1) {
      const outcome = await tenantDb.withTenant(clientId, (tx) => {
        const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
        return onSendOutcome(ctx, { instanceId, errorClass: 'rate_limited' });
      });
      forcedResults.push(outcome.bandForced);
    }

    // Only the FIRST call (while still healthy) actually forces WATCH; the
    // remaining 49 read back an already-WATCH-or-worse band and no-op on the
    // band-forcing write (fast-lane.ts's own rank-compare guard) - never a
    // config_version stampede or 50 BAND_CHANGE rows.
    expect(forcedResults.filter(Boolean)).toHaveLength(1);

    const bandChangeRows = await pool.query(
      `SELECT id FROM pacing_events WHERE client_id = $1 AND instance_id = $2 AND kind = 'BAND_CHANGE'`,
      [clientId, instanceId],
    );
    expect(bandChangeRows.rows).toHaveLength(1);

    const stateRow = await pool.query<{ config_version: number; health_band: string }>(
      `SELECT config_version, health_band FROM instance_pacing_state WHERE instance_id = $1`,
      [instanceId],
    );
    expect(stateRow.rows[0]?.health_band).toBe('watch');
    // 50 markDirty writes each tick, but only ONE config_version bump.
    expect(stateRow.rows[0]?.config_version).toBe(2);
  });

  it('resume_then_hard_signal_pause_lands_on_paused_pause_wins_when_it_is_the_later_write', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'paused',
      healthBand: 'critical',
    });
    await pool.query(
      `UPDATE whatsapp_instances SET pause_reason = 'provider_restriction', needs_user_action = true WHERE id = $1`,
      [instanceId],
    );

    // Sequenced (not sampled): a human resume commits first, then a
    // hard-signal pause (e.g. an immediate re-restriction) commits second -
    // the deterministic outcome is 'paused' again, because hard-signal-pause
    // is unconditional on health_state (only pause_reason-scoped), while
    // humanResume is conditional on health_state = 'paused'.
    const resumeResult = await tenantDb.withTenant(clientId, (tx) =>
      humanResume(tx, { clientId, instanceId, actor: { type: 'user', userId: 'user-1' } }),
    );
    expect(resumeResult.resumed).toBe(true);

    const midState = await pool.query<{ health_state: string }>(
      `SELECT health_state FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(midState.rows[0]?.health_state).toBe('degraded');

    const pauseResult = await tenantDb.withTenant(clientId, (tx) =>
      applyHardSignalPause(tx, {
        ...baseHardSignalInput(clientId, instanceId),
        pauseReason: 'provider_restriction',
      }),
    );
    expect(pauseResult.paused).toBe(true);

    const finalState = await pool.query<{ health_state: string; pause_reason: string | null }>(
      `SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(finalState.rows[0]?.health_state).toBe('paused');
    expect(finalState.rows[0]?.pause_reason).toBe('provider_restriction');
  });

  it('two_concurrent_human_resume_calls_on_the_same_paused_instance_at_most_one_applies', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'paused',
      healthBand: 'critical',
    });
    await pool.query(
      `UPDATE whatsapp_instances SET pause_reason = 'provider_restriction', needs_user_action = true WHERE id = $1`,
      [instanceId],
    );

    // True concurrency: two independent withTenant transactions racing on
    // the SAME conditional UPDATE (WHERE health_state = 'paused'). Postgres
    // serializes the two UPDATEs; whichever commits first flips the row out
    // of 'paused', so the second's WHERE clause matches zero rows.
    const [a, b] = await Promise.all([
      tenantDb.withTenant(clientId, (tx) =>
        humanResume(tx, { clientId, instanceId, actor: { type: 'user', userId: 'user-a' } }),
      ),
      tenantDb.withTenant(clientId, (tx) =>
        humanResume(tx, { clientId, instanceId, actor: { type: 'user', userId: 'user-b' } }),
      ),
    ]);

    // Invariant asserted directly, never a sampled "usually one wins" count:
    // exactly one of the two concurrent calls actually applied the write.
    const resumedFlags = [a.resumed, b.resumed].filter(Boolean);
    expect(resumedFlags).toHaveLength(1);

    const finalState = await pool.query<{ health_state: string }>(
      `SELECT health_state FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(finalState.rows[0]?.health_state).toBe('degraded');
  });
});
