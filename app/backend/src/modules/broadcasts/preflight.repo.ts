import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadNamedQuery, loadQuery } from '@wp/db';

/**
 * preflight.repo.ts (P23a Unit U1a, step 2) - SQL-only DB access for the
 * pre-flight quote: the instance's effective pacing thresholds (mirrors
 * `send-loop-guard-pipeline-wiring.ts#readGuardPipelineState`'s shape),
 * today's sent count (the SAME stored `pacing_ledger` row the card reads,
 * never a re-derived count), the client-level frequency-deferral count over
 * one batch of phone hashes, the wallet balance, and the conditional quote
 * stamp. All queries scoped by `client_id` (core invariant 4).
 */

export interface PreflightInstanceThresholds {
  label: string;
  warmupTier: number;
  effDailyCap: number;
  dupFanoutWarn: number;
  dupFanoutAck: number;
  perRecipient24h: number;
  perRecipient7d: number;
}

interface ThresholdsRow extends Record<string, unknown> {
  label: string | null;
  warmup_tier: number;
  eff_daily_cap: number;
  dup_fanout_warn: number;
  dup_fanout_ack: number;
  per_recipient_24h: number;
  per_recipient_7d: number;
}

/** Reads the instance's effective pacing-profile thresholds + label - `undefined` when the instance has no pacing state row. */
export async function readPreflightInstanceThresholds(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<PreflightInstanceThresholds | undefined> {
  const query = await loadNamedQuery('broadcast-preflight', 'preflight-instance-thresholds');
  const result = await tx.query<ThresholdsRow>(
    query.text,
    bindQueryParams(query, { instance_id: instanceId, client_id: clientId }),
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    label: row.label ?? '',
    warmupTier: row.warmup_tier,
    effDailyCap: row.eff_daily_cap,
    dupFanoutWarn: row.dup_fanout_warn,
    dupFanoutAck: row.dup_fanout_ack,
    perRecipient24h: row.per_recipient_24h,
    perRecipient7d: row.per_recipient_7d,
  };
}

/** Reads today's sent count from the SAME stored `pacing_ledger` row the instance card reads - a missing row (nothing sent yet today) is 0, never an error. */
export async function readPreflightSentToday(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const query = await loadQuery('instance-card-usage');
  const result = await tx.query<{ consumed_count: number | null }>(
    query.text,
    bindQueryParams(query, { client_id: clientId, instance_id: instanceId }),
  );
  return result.rows[0]?.consumed_count ?? 0;
}

/** Counts, out of `phoneHashes`, how many already sit at/over the client's per-recipient 24h or 7d limit - deny-at->= (see the .sql file's own header). Empty input short-circuits to 0 (never binds an empty array need). */
export async function countPreflightFrequencyDeferrals(
  tx: TenantQueryable,
  clientId: string,
  phoneHashes: Buffer[],
  limits: { perRecipient24h: number; perRecipient7d: number },
): Promise<number> {
  if (phoneHashes.length === 0) return 0;
  const query = await loadNamedQuery('broadcast-preflight', 'preflight-frequency-deferrals');
  const result = await tx.query<{ deferred_count: string }>(
    query.text,
    bindQueryParams(query, {
      client_id: clientId,
      phone_hashes: phoneHashes,
      per_recipient_24h: limits.perRecipient24h,
      per_recipient_7d: limits.perRecipient7d,
    }),
  );
  return Number(result.rows[0]?.deferred_count ?? 0);
}

/** Reads the wallet balance (integer paise) - `undefined` when the client has no wallet_accounts row. */
export async function readPreflightWalletBalance(
  tx: TenantQueryable,
  clientId: string,
): Promise<number | undefined> {
  const result = await tx.query<{ balance_minor: string }>(
    `SELECT balance_minor::text AS balance_minor FROM wallet_accounts WHERE client_id = $1
      -- client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? Number(row.balance_minor) : undefined;
}

/** Today's `pacing_ledger.group_sent_count` for the instance's LOCAL ledger day (P24 Unit U6) - reuses U3's own `groups-cap-today.sql` list-route query, 0 when no row exists yet for today. */
export async function readGroupSentToday(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const query = await loadQuery('groups-cap-today');
  const result = await tx.query<{ sent_today: number }>(
    query.text,
    bindQueryParams(query, { client_id: clientId, instance_id: instanceId }),
  );
  return result.rows[0]?.sent_today ?? 0;
}

/** Conditionally stamps `quote_minor`/`price_key` onto the campaign - a no-op (0 rows) when the campaign moved out of `draft`/`scheduled` concurrently; never touches `audience_count` (the snapshot owns it). */
export async function stampPreflightQuote(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  quoteMinor: number,
  priceKey: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE campaigns SET quote_minor = $3, price_key = $4, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status IN ('draft','scheduled')
      -- client_id = $2`,
    [campaignId, clientId, quoteMinor, priceKey],
  );
  return (result.rowCount ?? 0) > 0;
}
