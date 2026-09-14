import type { TenantQueryable } from '@wp/db';
import { PRICE_KEYS, type PriceKey } from '@wp/domain';
import { readEffectiveRates, writeMaxRate } from './wallet.repo.js';

/**
 * pricing.ts (P18 Unit U2) - resolves the rate a client actually pays for a
 * price key, and materialises `wallet_accounts.max_rate_minor` from the
 * client's full effective price list. An "unpriced" key (no client_pricing
 * row, a null rate, or a non-positive rate) is a NAMED error, never a
 * silent 0 - a 0 rate would let the claim predicate's `balance_minor >=
 * max_rate_minor` admit a client who can never actually be charged.
 */
export class UnpricedKeyError extends Error {
  readonly code = 'WALLET_UNPRICED_KEY';

  constructor(priceKey: string, clientId: string) {
    super(`wallet: price key "${priceKey}" is not priced for client ${clientId}`);
    this.name = 'UnpricedKeyError';
  }
}

function isValidRate(rateMinor: number | null): rateMinor is number {
  return rateMinor !== null && Number.isSafeInteger(rateMinor) && rateMinor > 0;
}

/**
 * Resolves the effective rate (client override, else the client's price
 * list item) for one price key. Throws `UnpricedKeyError` rather than ever
 * returning 0 or null.
 */
export async function resolveRateMinor(
  tx: TenantQueryable,
  clientId: string,
  priceKey: PriceKey,
): Promise<number> {
  const rows = await readEffectiveRates(tx, clientId);
  const row = rows.find((r) => r.priceKey === priceKey);

  if (!row || !isValidRate(row.rateMinor)) {
    throw new UnpricedKeyError(priceKey, clientId);
  }
  return row.rateMinor;
}

/**
 * Reads all four effective price keys for `clientId` and writes the
 * maximum as `wallet_accounts.max_rate_minor`. MUST be called inside the
 * same transaction as the pricing change it follows (ADR 0019 S11), so
 * `claim-jobs.sql`'s `balance_minor >= max_rate_minor` predicate never
 * reads a stale value on the very next claim.
 *
 * Fails closed on either side: if ANY of the four keys is unpriced, throws
 * `UnpricedKeyError` before issuing any write; if the wallet row itself
 * does not exist (0 rows updated), throws a plain `Error` - a materialise
 * call for a client with no wallet account is a caller bug, not a
 * recoverable state.
 */
export async function materialiseMaxRate(tx: TenantQueryable, clientId: string): Promise<number> {
  const rows = await readEffectiveRates(tx, clientId);

  let maxRateMinor = 0;
  for (const priceKey of PRICE_KEYS) {
    const row = rows.find((r) => r.priceKey === priceKey);
    if (!row || !isValidRate(row.rateMinor)) {
      throw new UnpricedKeyError(priceKey, clientId);
    }
    if (row.rateMinor > maxRateMinor) {
      maxRateMinor = row.rateMinor;
    }
  }

  const rowCount = await writeMaxRate(tx, clientId, maxRateMinor);
  if (rowCount === 0) {
    throw new Error(`materialiseMaxRate: no wallet_accounts row for client ${clientId}`);
  }
  return maxRateMinor;
}
