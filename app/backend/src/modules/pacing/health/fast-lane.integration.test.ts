import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';
import { classifySendError } from '../../../provider/baileys/error-map.js';
import { onConnectionUpdate, onSendOutcome, type FastLaneCtx } from './fast-lane.js';
import { humanResume } from './human-resume.js';

/**
 * fast-lane.integration.test.ts (P16 Unit C, step 6) - real PG, fake clock.
 * The PII/no-phone-number-or-JID regex check reuses `classifySendError`'s
 * own carve-out test values (real 403/JID shapes) rather than inventing new
 * ones, so the evidence-serialization assertion below is testing against
 * genuinely JID-shaped input, not a synthetic string that happens to look
 * safe.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'fast-lane-test' });
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
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

async function readInstanceState(instanceId: string) {
  const result = await pool.query<{
    health_state: string;
    pause_reason: string | null;
    needs_user_action: boolean;
    user_action_reason: string | null;
  }>(
    `SELECT health_state, pause_reason, needs_user_action, user_action_reason
       FROM whatsapp_instances WHERE id = $1`,
    [instanceId],
  );
  return result.rows[0];
}

async function seedQueuedJob(clientId: string, instanceId: string): Promise<string> {
  const recipientJid = `${crypto.randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 3, 'queued', now(), now(),
             0, 5, false)
     RETURNING id`,
    [clientId, instanceId, recipientJid, JSON.stringify({ text: 'probe' })],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('seedQueuedJob: no row returned');
  return id;
}

/** Wraps a real `tx` so the query matching `health-send-history-30d.sql`'s `AS sent_30d` projection rejects, simulating a dropped grant/timeout on that single read - every other statement on the same transaction passes through untouched. */
function withFailingSendHistoryQuery(tx: TenantQueryable): TenantQueryable {
  return {
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes('AS sent_30d')) {
        return Promise.reject(new Error('simulated send-history-30d read failure'));
      }
      return tx.query(sql, params);
    },
  };
}

describe('fast-lane (P16 Unit C, real Postgres)', () => {
  it('a_failing_send_history_fetch_never_blocks_the_pause_from_committing', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    await tenantDb.withTenant(clientId, async (tx) => {
      const scopedCtx: FastLaneCtx = {
        sql: withFailingSendHistoryQuery(tx),
        clientId,
        clock: { now: () => NOW_MS },
      };
      const result = await onConnectionUpdate(scopedCtx, { instanceId, disconnectCode: 403 });
      expect(result.paused).toBe(true);
    });

    const state = await readInstanceState(instanceId);
    expect(state?.health_state).toBe('paused');
    expect(state?.pause_reason).toBe('provider_restriction');

    const eventRow = await pool.query<{ to_value: unknown }>(
      `SELECT to_value FROM pacing_events
        WHERE client_id = $1 AND instance_id = $2 AND kind = 'hard_signal_pause'`,
      [clientId, instanceId],
    );
    const payload = eventRow.rows[0]?.to_value as Record<string, unknown>;
    expect(payload.send_history_30d).toEqual({ sent_30d: -1, failed_30d: -1, delivered_30d: -1 });

    const [auditRow, outboxRow] = await Promise.all([
      pool.query(
        `SELECT 1 FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'instance.paused'`,
        [clientId, instanceId],
      ),
      pool.query(
        `SELECT 1 FROM outbox_events WHERE client_id = $1 AND event_type = 'instance.paused'`,
        [clientId],
      ),
    ]);
    expect(auditRow.rows).toHaveLength(1);
    expect(outboxRow.rows).toHaveLength(1);
  });
  it('hard_restriction_signal_pauses_immediately', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });
    const jobId = await seedQueuedJob(clientId, instanceId);

    await tenantDb.withTenant(clientId, async (tx) => {
      const scopedCtx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
      const result = await onConnectionUpdate(scopedCtx, { instanceId, disconnectCode: 403 });
      expect(result.paused).toBe(true);
    });

    const state = await readInstanceState(instanceId);
    expect(state?.health_state).toBe('paused');
    expect(state?.pause_reason).toBe('provider_restriction');
    expect(state?.needs_user_action).toBe(true);

    // Zero further claims: the seeded job is still queued, never lost.
    const jobRow = await pool.query<{ status: string }>(
      `SELECT status FROM message_jobs WHERE id = $1`,
      [jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');

    const outboxRow = await pool.query<{ event_type: string; fanout: string[] }>(
      `SELECT event_type, fanout FROM outbox_events WHERE client_id = $1 AND event_type = 'instance.paused'`,
      [clientId],
    );
    expect(outboxRow.rows).toHaveLength(1);
    expect(outboxRow.rows[0]?.fanout.sort()).toEqual(['sse', 'webhook']);
  });

  it('hard_signal_pause_row_carries_the_full_vector_and_no_pii', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    await tenantDb.withTenant(clientId, async (tx) => {
      const scopedCtx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
      await onConnectionUpdate(scopedCtx, { instanceId, disconnectCode: 403 });
    });

    const eventRow = await pool.query<{ to_value: unknown; reason_codes: string[] }>(
      `SELECT to_value, reason_codes FROM pacing_events
        WHERE client_id = $1 AND instance_id = $2 AND kind = 'hard_signal_pause'`,
      [clientId, instanceId],
    );
    expect(eventRow.rows).toHaveLength(1);
    const serialized = JSON.stringify(eventRow.rows[0]?.to_value);
    expect(serialized).not.toMatch(/@s\.whatsapp\.net/);
    expect(serialized).not.toMatch(/@g\.us/);
    expect(serialized).not.toMatch(/\+?\d{10,}/);
    const payload = eventRow.rows[0]?.to_value as Record<string, unknown>;
    expect(payload).toHaveProperty('signals');
    expect(payload).toHaveProperty('effective_limits');
    expect(payload).toHaveProperty('warmup_tier');
    expect(payload).toHaveProperty('account_age_days');
    expect(payload).toHaveProperty('send_history_30d');

    // CRITICAL 2 fix (P16 fix round): the vector is the REAL 12-signal
    // evidence, the REAL eff_* limits (exact value, matching
    // seedPacingInstance's own default dailyCap of 20), and a real 30-day
    // history summary - never `{}` stubs that read as "we looked and found
    // nothing".
    const signals = payload.signals as Record<string, unknown>;
    expect(Object.keys(signals)).toHaveLength(12);

    const effectiveLimits = payload.effective_limits as Record<string, unknown>;
    expect(Object.keys(effectiveLimits).length).toBeGreaterThan(0);
    expect(effectiveLimits.eff_daily_cap).toBe(20);

    const sendHistory30d = payload.send_history_30d as Record<string, unknown>;
    expect(sendHistory30d).toEqual({ sent_30d: 0, failed_30d: 0, delivered_30d: 0 });
  });

  it('rate_limited_forces_at_least_watch_within_one_tick', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      healthState: 'connected',
      healthBand: 'healthy',
    });

    const forced = await tenantDb.withTenant(clientId, async (tx) => {
      const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
      return onSendOutcome(ctx, { instanceId, errorClass: 'rate_limited' });
    });
    expect(forced.bandForced).toBe(true);

    const row = await pool.query<{ health_band: string; eff_gap_min_ms: number }>(
      `SELECT health_band, eff_gap_min_ms FROM instance_pacing_state WHERE instance_id = $1`,
      [instanceId],
    );
    expect(row.rows[0]?.health_band).toBe('watch');
    // system profile gap_min_floor_ms=15000, tier-1 gapMinMs=45000 -> max=45000,
    // WATCH gapMultiplier=1.5 -> ceil(45000*1.5)=67500 (exact).
    expect(row.rows[0]?.eff_gap_min_ms).toBe(67500);
  });

  it('a_group_forbidden_error_never_pauses_the_instance', async () => {
    const notAdmin = { message: 'not-admin', output: { statusCode: 403, headers: {} } };
    const result = classifySendError(notAdmin, { recipientJid: '120363012345678901@g.us' });
    expect(result.sendErrorClass).toBe('group_forbidden');

    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });

    // A group_forbidden send outcome is not a fast-lane trigger at all -
    // onSendOutcome only reacts to 'rate_limited'.
    const outcome = await tenantDb.withTenant(clientId, async (tx) => {
      const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
      return onSendOutcome(ctx, { instanceId, errorClass: result.sendErrorClass });
    });
    expect(outcome.bandForced).toBe(false);

    const state = await readInstanceState(instanceId);
    expect(state?.health_state).toBe('connected');

    const pauseRows = await pool.query(
      `SELECT 1 FROM pacing_events WHERE client_id = $1 AND kind = 'hard_signal_pause'`,
      [clientId],
    );
    expect(pauseRows.rows).toHaveLength(0);
  });

  it('pause_preserves_work_and_human_resume_clears_paused_state', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      healthState: 'connected',
      healthBand: 'healthy',
    });
    const jobIds = await Promise.all(
      Array.from({ length: 10 }, () => seedQueuedJob(clientId, instanceId)),
    );

    await tenantDb.withTenant(clientId, async (tx) => {
      const ctx: FastLaneCtx = { sql: tx, clientId, clock: { now: () => NOW_MS } };
      await onConnectionUpdate(ctx, { instanceId, disconnectCode: 403 });
    });

    const queuedCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM message_jobs WHERE id = ANY($1) AND status = 'queued'`,
      [jobIds],
    );
    expect(Number(queuedCount.rows[0]?.count)).toBe(10);

    const resumeResult = await tenantDb.withTenant(clientId, (tx) =>
      humanResume(tx, { clientId, instanceId, actor: { type: 'user', userId: 'user-1' } }),
    );
    expect(resumeResult.resumed).toBe(true);

    const state = await readInstanceState(instanceId);
    expect(state?.health_state).toBe('degraded');
    expect(state?.pause_reason).toBeNull();
    expect(state?.needs_user_action).toBe(false);

    const stillQueued = await pool.query<{ count: string }>(
      `SELECT count(*) FROM message_jobs WHERE id = ANY($1) AND status = 'queued'`,
      [jobIds],
    );
    expect(Number(stillQueued.rows[0]?.count)).toBe(10);
  });
});
