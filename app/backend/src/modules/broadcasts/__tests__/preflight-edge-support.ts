import {
  seedBroadcastTenant,
  type SeededBroadcastTenant,
  type TestPool,
} from './broadcasts-test-support.js';
import {
  seedPreflightPacingState,
  seedPreflightPricing,
  seedPreflightWallet,
} from './preflight-test-support.js';

/**
 * preflight-edge-support.ts (P23a test-engineer hardening pass) - shared
 * fixture helpers for `preflight-edge.integration.test.ts` and its
 * max-lines sibling `preflight-c2.integration.test.ts`. Lives under
 * `__tests__/` for the same tenant-scope guard exemption as its sibling
 * support files (no `.test.ts` suffix, never picked up as its own suite).
 */

/** Seeds a full pre-flight-ready tenant: pacing state (safe_default profile), pricing (default_inr), and a generous wallet balance. */
export async function seedFullTenant(
  pool: TestPool,
  probeClientIds: string[],
  maxBroadcastRecipients?: number,
): Promise<SeededBroadcastTenant> {
  const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients });
  await seedPreflightPacingState(pool, tenant);
  await seedPreflightPricing(pool, tenant.clientId);
  await seedPreflightWallet(pool, tenant.clientId);
  return tenant;
}

/** Reads the tenant's effective per-recipient 24h/7d deferral thresholds straight from the seeded pacing profile - never a hard-coded number in a test. */
export async function readLimits(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
): Promise<{ perRecipient24h: number; perRecipient7d: number }> {
  const result = await pool.query<{ per_recipient_24h: number; per_recipient_7d: number }>(
    `SELECT p.per_recipient_24h AS per_recipient_24h, p.per_recipient_7d AS per_recipient_7d
       FROM instance_pacing_state s JOIN pacing_profiles p ON p.key = s.profile_key
      WHERE s.instance_id = $1 AND s.client_id = $2`,
    [tenant.instanceId, tenant.clientId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('readLimits: no pacing profile row');
  return { perRecipient24h: row.per_recipient_24h, perRecipient7d: row.per_recipient_7d };
}

/** Inserts one `recipient_send_buckets` row `hoursAgo` hours in the past (0 = the current hour). */
export async function insertBucket(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  clientId: string,
  phoneHash: Buffer,
  count: number,
  hoursAgo = 0,
): Promise<void> {
  await pool.query(
    `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
     VALUES ($1, $2, date_trunc('hour', now() - ($3 * interval '1 hour')), $4)`,
    [clientId, phoneHash, hoursAgo, count],
  );
}
