import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * __tests__/pacing-test-helpers.ts (P13 Unit U4) - shared, non-test fixture
 * machinery for the pacing integration suite
 * (`reserve-*.integration.test.ts`, `deferral.integration.test.ts`,
 * `config-service.integration.test.ts`). Mirrors `modules/queue/__tests__/
 * claim-test-helpers.ts`'s own shape: seed a client + whatsapp_instance +
 * instance_pacing_state (with caller-overridable `eff_*` caps), push the
 * client id for cleanup. Lives under `__tests__/` (not a standalone
 * `__test-support__/` directory) so `scripts/check-tenant-scope.ts`'s
 * seed/cleanup exemption (`TEST_FILE_PATTERN`, keyed on the literal
 * `__tests__` path segment) covers its raw, unscoped `DELETE`/`INSERT`
 * statements - a `__test-support__` directory does NOT match that pattern,
 * verified live. Its own filename (not `claim-test-helpers.ts`, etc.) is
 * what keeps it from colliding with the sibling `provision.ts` unit's own
 * fixtures - not the directory.
 */

export type TestPool = ReturnType<typeof createPool>;

export interface SeedPacingInstanceOptions {
  dailyCap?: number;
  hourlyCap?: number;
  newConvCap?: number;
  gapMinMs?: number;
  gapMaxMs?: number;
  coldRatioMax?: number;
  coldRatioFloor?: number;
  windowStartLocal?: string;
  windowEndLocal?: string;
  groupDailyCap?: number;
  pacingTimezone?: string;
  /** P13a Unit U1 (warmup-ladder evaluator fixtures) - defaults below match this file's existing tier-1/healthy/never-linked defaults exactly, so no other test in this suite changes behaviour. */
  warmupTier?: number;
  warmupStartedAt?: Date | null;
  warmupTierSince?: Date | null;
  healthBand?: string;
  /** `whatsapp_instances.health_state` - defaults to `'connected'` (existing behaviour); the evaluator's paused-skip test overrides to `'paused'`. */
  healthState?: string;
}

export interface SeededPacingInstance {
  clientId: string;
  instanceId: string;
}

/** Deletes every row seeded (directly or transitively) under the given probe client ids. */
export async function cleanupPacingProbeClients(
  pool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  // P17 U6 (step 5) - reserve()'s PLAN_CAP deny path now also calls notify();
  // notifications.instance_id/client_id have no ON DELETE CASCADE, so a
  // leaked row would FK-block the DELETE FROM whatsapp_instances/clients below.
  // FIX (P17 close, gate attempt 4): notify() also writes 3 outbox_events
  // rows per notification (sse/webhook/email fanout) via the same emit()
  // call - outbox_events has no FK to clients either, so it was leaking
  // forever and poisoning any later drainOnce/runOneReconcilerSweep-driving
  // test (both cross-tenant scans) - same mechanism as the P16 lesson.
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  // FIX-P26-D (run log row 26): `evaluator-fixtures.ts`'s `primeInstanceTo
  // Watch` seeds send_attempts/delivery_events rows keyed to fake
  // message_job_id values, NOT to a real message_jobs row - this function
  // used to delete message_jobs only, leaking send_attempts/delivery_events
  // forever. Both are deleted before message_jobs (neither carries a real
  // FK to it - `send_attempts`/`delivery_events`.message_job_id is a plain
  // bigint - but this order still matches the read-path's own join shape).
  await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM pacing_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_pacing_overrides WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM pacing_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_daily_usage WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
}

/** Creates a client + whatsapp_instance + instance_pacing_state row with caller-overridable `eff_*` caps. Pushes the new client id onto `probeClientIds`. */
export async function seedPacingInstance(
  pool: TestPool,
  probeClientIds: string[],
  options: SeedPacingInstanceOptions = {},
): Promise<SeededPacingInstance> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Pacing Probe Client',
    `pacing-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'probe', $3, 0)`,
    [instanceId, clientId, options.healthState ?? 'connected'],
  );
  await pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, pacing_timezone, warmup_tier, warmup_started_at, warmup_tier_since,
       health_band,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      instanceId,
      clientId,
      options.pacingTimezone ?? 'Asia/Kolkata',
      options.warmupTier ?? 1,
      options.warmupStartedAt ?? null,
      options.warmupTierSince ?? null,
      options.healthBand ?? 'healthy',
      options.dailyCap ?? 20,
      options.hourlyCap ?? 6,
      options.newConvCap ?? 8,
      options.gapMinMs ?? 15_000,
      options.gapMaxMs ?? 180_000,
      options.coldRatioMax ?? 0.4,
      options.coldRatioFloor ?? 5,
      options.windowStartLocal ?? '00:00:00',
      options.windowEndLocal ?? '23:59:59',
      options.groupDailyCap ?? 0,
    ],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

export interface SeedMessageJobOptions {
  clientId: string;
  instanceId: string;
}

/** Seeds one minimal `message_jobs` row (queued) - just enough for the deferral/refund tests to point `release()`/deny-writes at a real job id. `id` is `GENERATED ALWAYS AS IDENTITY` (never supplied). */
export async function seedPacingMessageJob(
  pool: TestPool,
  options: SeedMessageJobOptions,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs (
       client_id, instance_id, recipient_jid, recipient_e164,
       payload, payload_kind, priority, priority_rank, status
     ) VALUES ($1, $2, '15550000000@s.whatsapp.net', '+15550000000', $3, 'text', 'normal', 10, 'queued')
     RETURNING id`,
    [options.clientId, options.instanceId, JSON.stringify({ text: 'probe' })],
  );
  const id = result.rows[0]?.id;
  if (id === undefined)
    throw new Error('seedPacingMessageJob: INSERT ... RETURNING id returned no row');
  return id;
}
