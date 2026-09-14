import { nextWalletState, type WalletState } from '@wp/domain';
import type { AdminAppQueryable } from '../staff-audit.js';

/**
 * routes/wallet-freeze-state.ts (P28 C1 review round 2, MAJOR 1 fix) -
 * `applyFreezeOrUnfreeze`, split out of `routes/wallet.ts` purely for that
 * file's own `max-lines: 300` cap (the established sibling-split idiom, see
 * `session-worker-discovery-wiring.ts`). Owns the ONE conditional UPDATE for
 * each direction:
 *
 * - freeze: `state = 'frozen' WHERE state <> 'frozen'` - unconditional, no
 *   derivation needed.
 * - unfreeze: derives the post-freeze state by calling `@wp/domain`'s
 *   `nextWalletState` - never a second hand-rolled SQL CASE. The prior
 *   in-SQL CASE used `<=` for the low-balance boundary where the canonical
 *   derivation (and `db/queries/wallet-credit.sql`'s own CASE) use strict
 *   `<`, so a balance exactly AT the threshold was wrongly derived 'low'
 *   instead of 'active'. `currentState` is passed as 'active' (never
 *   'frozen') so `nextWalletState`'s frozen-is-absorbing branch never fires
 *   - this call site's whole purpose is computing what the wallet becomes
 *   AFTER leaving frozen. The read and the write both run inside the
 *   caller's `withStaffMutation` transaction, and the write's own
 *   `WHERE state = 'frozen'` still guards against a concurrent change
 *   between the read and the write.
 */

export async function applyFreezeOrUnfreeze(
  tx: AdminAppQueryable,
  clientId: string,
  action: 'wallet.freeze' | 'wallet.unfreeze',
): Promise<{ state: WalletState } | undefined> {
  if (action === 'wallet.freeze') {
    const updateResult = await tx.query<{ state: WalletState }>(
      `UPDATE wallet_accounts SET state = 'frozen', updated_at = now()
          WHERE client_id = $1 AND state <> 'frozen'
        RETURNING state`,
      [clientId],
    );
    return updateResult.rows[0];
  }

  const before = await tx.query<{
    balance_minor: string;
    low_balance_threshold_minor: string;
    max_rate_minor: string;
  }>(
    `SELECT balance_minor::text AS balance_minor,
            low_balance_threshold_minor::text AS low_balance_threshold_minor,
            max_rate_minor::text AS max_rate_minor
       FROM wallet_accounts WHERE client_id = $1 AND state = 'frozen'`,
    [clientId],
  );
  const beforeRow = before.rows[0];
  if (!beforeRow) {
    return undefined;
  }
  const derived = nextWalletState({
    balanceMinor: Number(beforeRow.balance_minor),
    maxRateMinor: Number(beforeRow.max_rate_minor),
    lowThresholdMinor: Number(beforeRow.low_balance_threshold_minor),
    currentState: 'active',
  });
  const updateResult = await tx.query<{ state: WalletState }>(
    `UPDATE wallet_accounts SET state = $2, updated_at = now()
        WHERE client_id = $1 AND state = 'frozen'
      RETURNING state`,
    [clientId, derived],
  );
  return updateResult.rows[0];
}
