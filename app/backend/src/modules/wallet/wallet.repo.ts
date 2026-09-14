import type { TenantQueryable } from '@wp/db';
import { PRICE_KEYS } from '@wp/domain';

/**
 * wallet.repo.ts (P18 Unit U2) - SQL only, no pricing policy. Every
 * statement carries `client_id = $1` (tenant-scope guard) even though RLS
 * already enforces isolation, per the always-scoped-query convention used
 * across the other `*.repo.ts` files in this repo.
 */

export interface EffectiveRateRow {
  priceKey: string;
  rateMinor: number | null;
}

/**
 * Reads the four price keys' effective rate for `clientId` in one
 * statement: the client's `override_items` entry wins per key, else the
 * client's price list's `price_list_items` row. Returns `[]` (not one row
 * per key with null rates) when the client has no `client_pricing` row at
 * all - the `CROSS JOIN` against `client_pricing` yields zero rows when the
 * left side is empty.
 */
export async function readEffectiveRates(
  tx: TenantQueryable,
  clientId: string,
): Promise<EffectiveRateRow[]> {
  const result = await tx.query<{ price_key: string; rate_minor: string | null }>(
    `SELECT k.key AS price_key,
            COALESCE((cp.override_items ->> k.key)::bigint, pli.rate_minor)::text AS rate_minor
       FROM client_pricing cp
       CROSS JOIN unnest($2::text[]) AS k(key)
       LEFT JOIN price_list_items pli
         ON pli.price_list_key = cp.price_list_key AND pli.price_key = k.key
      WHERE cp.client_id = $1`,
    [clientId, [...PRICE_KEYS]],
  );

  return result.rows.map((row) => ({
    priceKey: row.price_key,
    rateMinor: row.rate_minor === null ? null : Number(row.rate_minor),
  }));
}

/** Same shape as `readEffectiveRates`, narrowed to one price key. */
export async function readEffectiveRate(
  tx: TenantQueryable,
  clientId: string,
  priceKey: string,
): Promise<number | null> {
  const rows = await readEffectiveRates(tx, clientId);
  const row = rows.find((r) => r.priceKey === priceKey);
  return row ? row.rateMinor : null;
}

/**
 * Overwrites `wallet_accounts.max_rate_minor` for `clientId`. Returns the
 * affected row count so callers can fail closed when the wallet row does
 * not exist (0 rows updated).
 */
export async function writeMaxRate(
  tx: TenantQueryable,
  clientId: string,
  maxRateMinor: number,
): Promise<number> {
  const result = await tx.query(
    `UPDATE wallet_accounts SET max_rate_minor = $2, updated_at = now() WHERE client_id = $1`,
    [clientId, maxRateMinor],
  );
  return result.rowCount ?? 0;
}
