import type { SeededBroadcastTenant, TestPool } from './broadcasts-test-support.js';

/**
 * preflight-test-support.ts (P23a Unit U1a, step 2) - fixture machinery
 * `preflight.integration.test.ts` needs beyond `broadcasts-test-support.ts`'s
 * shared helpers: `instance_pacing_state` (defaulting to the seeded
 * `safe_default` profile - never a hard-coded threshold), `client_pricing`
 * (required for `resolveRateMinor` to resolve anything at all - an absent
 * row is `UnpricedKeyError`, not a 0 rate), and `wallet_accounts`.
 */

/** Seeds `instance_pacing_state` for `tenant.instanceId` - `profile_key` defaults to `safe_default` (never override its thresholds; read them back from the DB in the test instead). */
export async function seedPreflightPacingState(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  options: { warmupTier?: number; effDailyCap?: number } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO instance_pacing_state (
       instance_id, client_id, warmup_tier,
       eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
       eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
       eff_window_start_local, eff_window_end_local, eff_group_daily_cap
     ) VALUES ($1, $2, $3, $4, 100000, 100000, 15000, 15000, 1, 0, '00:00:00', '23:59:59', 50)`,
    [tenant.instanceId, tenant.clientId, options.warmupTier ?? 1, options.effDailyCap ?? 600],
  );
}

/** Seeds a second `whatsapp_instances` + `instance_pacing_state` row for the SAME client (proves a second instance never raises the per-recipient limit). */
export async function seedPreflightSecondInstance(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  instanceId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'broadcast-probe-2', 'connected', 0)`,
    [instanceId, tenant.clientId],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, 1)`,
    [instanceId, tenant.clientId],
  );
  await seedPreflightPacingState(pool, { ...tenant, instanceId });
}

/** Seeds `client_pricing` (required for `resolveRateMinor`) pointing at the platform `default_inr` price list, with optional per-key overrides. */
export async function seedPreflightPricing(
  pool: TestPool,
  clientId: string,
  overrideItems: Record<string, number> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO client_pricing (client_id, price_list_key, override_items)
     VALUES ($1, 'default_inr', $2::jsonb)`,
    [clientId, JSON.stringify(overrideItems)],
  );
}

/** Seeds `wallet_accounts` with a generous balance (integer paise) - `max_rate_minor` is required NOT NULL/>0 but is not read by the pre-flight quote. */
export async function seedPreflightWallet(
  pool: TestPool,
  clientId: string,
  balanceMinor = 10_000_000,
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
     VALUES ($1, $2, 'active', 100)`,
    [clientId, balanceMinor],
  );
}
