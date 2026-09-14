import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * queue-send-tenant-fixture.ts (P13 Unit U4) - `seedSendTenant`/
 * `cleanupSendProbeClients`, split out of `queue-send-test-helpers.ts`
 * purely for that file's own max-lines cap (adding the P13
 * `instance_pacing_state` seed row pushed it over 300 - same split idiom as
 * `session-worker-discovery-wiring.ts`). Re-exported from
 * `queue-send-test-helpers.ts` so every existing caller's import path is
 * unchanged.
 */

export type TestPool = ReturnType<typeof createPool>;

export interface SeededSendTenant {
  clientId: string;
  instanceId: string;
}

export interface SeedSendTenantOptions {
  healthState?: string;
  fence?: number;
  /** `wallet_accounts.balance_minor` - defaults 100_000. */
  balanceMinor?: number;
  /** `wallet_accounts.state` - defaults 'active'. */
  walletState?: string;
  /** `wallet_accounts.max_rate_minor` - defaults 100. */
  maxRateMinor?: number;
}

export async function cleanupSendProbeClients(
  pool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  // P17 U6 (step 5) - notify() is now reachable from several send-path call
  // sites this fixture's callers exercise (duplicate_fanout_ack_required,
  // plan_cap_reached); notifications.client_id has no ON DELETE CASCADE, so
  // a leaked row would FK-block the DELETE FROM clients below.
  // FIX (P17 close, gate attempt 4): notify() ALSO writes 3 outbox_events
  // rows (sse/webhook/email fanout) per notification, via the SAME emit()
  // call - this delete list stopped one table short of the writes it
  // covers. outbox_events has no FK to clients/notifications, so an
  // unpublished orphan survives forever and later poisons any OTHER
  // drainOnce/runOneReconcilerSweep-driving test (both cross-tenant scans,
  // no client_id filter) - the exact P16 lesson mechanism, recurring at the
  // widest blast radius in this codebase (~69 files share this fixture).
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM delivery_event_ids WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_wa_ids WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  // P18 U3: wallet_charge_guards/wallet_ledger before wallet_accounts, and
  // client_pricing before wallet_accounts too (no FK order requirement
  // between the three, but this keeps the delete block in dependency-safe
  // order - see this function's own P17 fix note above for why an omitted
  // row here poisons a later, unrelated test).
  await pool.query('DELETE FROM wallet_charge_guards WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  // P18 U8b - the reconciler/rollup sweeps write these two tables; leaking a
  // probe row here poisons a later, unrelated cross-tenant scan (same P17
  // lesson mechanism as the block above).
  await pool.query('DELETE FROM wallet_reconcile_findings WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM wallet_daily_summary WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await pool.query('DELETE FROM pacing_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM pacing_ledger WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM client_daily_usage WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
  // P34 (2026-09-14): any send-path test that needs a media job now seeds a
  // REAL row here (`modules/media/__tests__/seed-media-asset.ts`) - dispatch
  // resolves `mediaId` against this table, so an invented payload no longer
  // works. `media_assets` has no ON DELETE CASCADE to clients, so a leaked
  // row FK-blocks the `DELETE FROM clients` below - the same mechanism the
  // P17 note above describes, and this fixture is shared by ~69 files.
  await pool.query('DELETE FROM media_assets WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
}

/**
 * Creates a client + whatsapp_instance + instance_lease_state +
 * wallet_accounts + client_pricing + instance_pacing_state (P13: `reserve()`
 * now requires this row for ANY grant - permissive caps here so no consumer
 * of this fixture is accidentally pacing-denied). P18 U3: also seeds
 * `client_pricing` against the seeded `default_inr` price list (migration
 * 0005) so every existing send-path test resolves a real rate through
 * `resolveRateMinor` instead of hitting `UnpricedKeyError`.
 */
export async function seedSendTenant(
  pool: TestPool,
  probeClientIds: string[],
  options: SeedSendTenantOptions = {},
): Promise<SeededSendTenant> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Send Probe Client',
    `send-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
    [
      clientId,
      options.balanceMinor ?? 100_000,
      options.walletState ?? 'active',
      options.maxRateMinor ?? 100,
    ],
  );
  await pool.query('INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)', [
    clientId,
    'default_inr',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'send-probe', $3, 0)`,
    [instanceId, clientId, options.healthState ?? 'connected'],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, options.fence ?? 1],
  );
  // FINDING 6 FIX (P13 C1 review): every eff_* value below is now IN-RANGE
  // against the absolute floors/ceilings db/migrations (`packages/domain/
  // src/pacing/constants.ts`'s ABSOLUTE_GAP_MIN_MS=15000,
  // ABSOLUTE_DAILY_CEILING=2000, ABSOLUTE_GROUP_DAILY_CEILING=50) now
  // enforce with real CHECK constraints - a stored value outside these is
  // structurally rejected, never just a TypeScript-layer convention. Was
  // previously `eff_gap_min_ms=eff_gap_max_ms=1` (below the 15000 floor)
  // and `eff_daily_cap=eff_group_daily_cap=100000` (above their ceilings) -
  // "effectively no floor for these pre-P13 send-path tests" doesn't
  // actually need a SUB-FLOOR stored value: `drawGapMs` (`@wp/domain`)
  // already internally clamps its floor to `ABSOLUTE_GAP_MIN_MS`
  // regardless of the stored `eff_gap_min_ms`, so the ACTUAL drawn gap was
  // always >= 15000ms either way - `eff_gap_min_ms=eff_gap_max_ms=15000`
  // (the floor itself) draws the same deterministic 15000ms gap these
  // tests always got. `eff_daily_cap=2000`/`eff_group_daily_cap=50` (the
  // ceilings themselves) are still far more headroom than any of these
  // tests' send counts need - "no pacing denial ever" still holds.
  await pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, warmup_tier,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, 1, 2000, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
    [instanceId, clientId],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}
