import type { WalletState } from '../enums/index.js';

/**
 * state.ts (P19 Unit U2, step 3) - the ONE authority for the
 * `wallet_accounts.state` transition. Both the debit statement
 * (`db/queries/debit-send.sql`) and the credit statement
 * (`db/queries/wallet-credit.sql`) embed a SQL `CASE` that must agree with
 * this function byte-for-byte in SHAPE (not literally the same code - SQL
 * cannot call TypeScript) - `packages/domain/test/wallet-state.test.ts`
 * asserts the pure boundary table here, and
 * `app/backend/src/modules/wallet/credit.integration.test.ts` asserts the
 * same boundary table through the real credit statement against a live
 * Postgres (this package stays browser-pure, no pg dependency).
 *
 * `frozen` is ABSORBING: it is checked FIRST and returned unconditionally,
 * before any balance comparison - a frozen wallet never flips back to
 * active/low/empty as a side effect of a credit or a debit (ADR 0019; only
 * an explicit staff unfreeze action changes it, elsewhere).
 *
 * Boundary semantics (mirrors the SQL `CASE` in both statements):
 *   balanceMinor <  maxRateMinor    -> 'empty'
 *   balanceMinor <  lowThresholdMinor -> 'low'
 *   otherwise                       -> 'active'
 *
 * Money params are `number` (integer paise), matching how
 * `packages/domain/src/pricing.ts` and its callers already carry
 * `rate_minor`/`balance_minor` as plain numbers end to end - never a float,
 * never `parseFloat`. No Node builtins, no `Date.now()` (wp/domain stays
 * browser-pure).
 */

export interface NextWalletStateInput {
  balanceMinor: number;
  maxRateMinor: number;
  lowThresholdMinor: number;
  currentState: WalletState;
}

export function nextWalletState(input: NextWalletStateInput): WalletState {
  if (input.currentState === 'frozen') {
    return 'frozen';
  }
  if (input.balanceMinor < input.maxRateMinor) {
    return 'empty';
  }
  if (input.balanceMinor < input.lowThresholdMinor) {
    return 'low';
  }
  return 'active';
}
