import type { AdminReadQueryable } from '../../platform/platform-read.js';
import { decodeCursor, encodeCursor, type KeysetPage } from '../../platform/keyset.js';

/**
 * modules/wallet/wallet.read.ts (P28 Unit U4, step 7) - the staff-facing
 * wallet reads: one client's wallet header (state, balance, rate ceiling,
 * low-balance threshold) and its keyset-paginated ledger.
 *
 * PROJECTION DISCIPLINE (deliberate, and narrower than the table):
 * `wallet_ledger` carries `external_ref` (the tenant-supplied UTR/bank
 * reference) and `reason` (free text a staff member typed on an earlier
 * adjustment). NEITHER is projected here. `external_ref` is a payment
 * identifier that ties a real bank transaction to a named person - it
 * belongs in the top-up review flow (where the reviewing staff member is
 * making a decision about that specific payment and is audited doing so),
 * not on a general ledger browse. `reason` is excluded for the same
 * reason: it is free text with no schema, so it is exactly where PII
 * accumulates. The ledger's own audit trail lives in `staff_audit_log`
 * (`GET /admin/v1/audit`), which DOES carry the staff reason, keyed to the
 * staff member who wrote it.
 *
 * EVERY paise amount is a decimal STRING, parsed from `::text` - never
 * through `Number()`. A rupee balance is a `bigint` in Postgres and real
 * money here; a float round-trip past 2^53 paise would silently corrupt it
 * (the same discipline `app/backend`'s `readTopupForDecision` documents).
 */

export interface WalletHeader {
  clientId: string;
  state: string;
  currency: string;
  /** PAISE, decimal string. */
  balanceMinor: string;
  maxRateMinor: string;
  lowThresholdMinor: string;
  updatedAt: string;
}

const READ_WALLET_SQL = `SELECT client_id,
         state::text AS state,
         currency::text AS currency,
         balance_minor::text AS balance_minor,
         max_rate_minor::text AS max_rate_minor,
         low_balance_threshold_minor::text AS low_threshold_minor,
         updated_at
    FROM wallet_accounts
   WHERE client_id = $1`;

interface RawWalletRow extends Record<string, unknown> {
  client_id: string;
  state: string;
  currency: string;
  balance_minor: string;
  max_rate_minor: string;
  low_threshold_minor: string;
  updated_at: Date;
}

/** ONE client's wallet header by primary key; `undefined` when the client has no wallet row. */
export async function readWalletAccount(
  db: AdminReadQueryable,
  clientId: string,
): Promise<WalletHeader | undefined> {
  const result = await db.query<RawWalletRow>(READ_WALLET_SQL, [clientId]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    clientId: row.client_id,
    state: row.state,
    currency: row.currency,
    balanceMinor: row.balance_minor,
    maxRateMinor: row.max_rate_minor,
    lowThresholdMinor: row.low_threshold_minor,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface WalletLedgerItem {
  seq: string;
  kind: string;
  /** PAISE, signed decimal string (credit > 0, debit < 0). */
  amountMinor: string;
  balanceAfterMinor: string;
  actorType: string;
  createdAt: string;
}

const LIST_LEDGER_SQL = `SELECT seq::text AS seq,
         kind::text AS kind,
         amount_minor::text AS amount_minor,
         balance_after_minor::text AS balance_after_minor,
         actor_type,
         created_at
    FROM wallet_ledger
   WHERE client_id = $1
     AND ($2::timestamptz IS NULL OR (created_at, seq) < ($2, $3::bigint))
   ORDER BY created_at DESC, seq DESC
   LIMIT $4`;

interface RawLedgerRow extends Record<string, unknown> {
  seq: string;
  kind: string;
  amount_minor: string;
  balance_after_minor: string;
  actor_type: string;
  created_at: Date;
}

/**
 * ONE client's ledger, newest first, keyset-paginated on
 * `(created_at, seq)` - `seq` is the table's own per-client monotonic
 * sequence, so this tuple is strictly ordered and unique within a client
 * (unlike a bare timestamp, which two same-transaction entries can share).
 */
export async function listWalletLedger(
  db: AdminReadQueryable,
  input: { clientId: string; limit: number; cursor?: string },
): Promise<KeysetPage<WalletLedgerItem>> {
  const cursor = decodeCursor(input.cursor);
  const result = await db.query<RawLedgerRow>(LIST_LEDGER_SQL, [
    input.clientId,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    input.limit,
  ]);
  const last = result.rows[result.rows.length - 1];
  return {
    items: result.rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      amountMinor: row.amount_minor,
      balanceAfterMinor: row.balance_after_minor,
      actorType: row.actor_type,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      result.rows.length === input.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.seq })
        : null,
  };
}

export interface ClientPricingView {
  priceListKey: string;
  overrideItems: Record<string, unknown>;
}

const READ_PRICING_SQL = `SELECT price_list_key, override_items
    FROM client_pricing WHERE client_id = $1`;

/** ONE client's price list + staff override map (the detail view's `pricing` block). */
export async function readClientPricing(
  db: AdminReadQueryable,
  clientId: string,
): Promise<ClientPricingView | undefined> {
  const result = await db.query<{
    price_list_key: string;
    override_items: Record<string, unknown>;
  }>(READ_PRICING_SQL, [clientId]);
  const row = result.rows[0];
  return row ? { priceListKey: row.price_list_key, overrideItems: row.override_items } : undefined;
}
