import { describe, expect, it } from 'vitest';
import { nextWalletState } from '../src/wallet/state.js';
import { WALLET_STATES, type WalletState } from '../src/enums/index.js';

/**
 * wallet-state.test.ts (P19 Unit U2, step 3) - the agreement test. This
 * file is the PURE half only (packages/domain has no DB): a deterministic
 * property-style sweep proving `frozen` is absorbing for every balance, and
 * a table-driven boundary sweep that the DB half in
 * `app/backend/src/modules/wallet/credit.integration.test.ts`
 * (`the_sql_case_agrees_with_next_wallet_state_on_every_boundary`) proves
 * the real `wallet-credit.sql` `CASE` reproduces exactly, boundary for
 * boundary, through a live Postgres. No `Math.random()` - every input here
 * is a fixed, enumerated value.
 */

const MAX_RATE = 100;
const LOW_THRESHOLD = 5000;

describe('nextWalletState', () => {
  it('frozen_is_absorbing_for_every_balance', () => {
    // Deterministic generated range: every 137th paise value from a large
    // negative overdraft to a large positive balance, plus the exact
    // boundary values themselves.
    const balances: number[] = [];
    for (let b = -50_000; b <= 200_000; b += 137) {
      balances.push(b);
    }
    balances.push(-1, 0, MAX_RATE - 1, MAX_RATE, LOW_THRESHOLD - 1, LOW_THRESHOLD);

    for (const balanceMinor of balances) {
      const result = nextWalletState({
        balanceMinor,
        maxRateMinor: MAX_RATE,
        lowThresholdMinor: LOW_THRESHOLD,
        currentState: 'frozen',
      });
      expect(result).toBe('frozen');
    }
  });

  it('the_ts_state_function_agrees_with_the_sql_case_on_every_boundary', () => {
    // Table-driven boundaries: maxRate-1, maxRate, threshold-1, threshold.
    // The DB half of this same table lives in
    // credit.integration.test.ts's `the_sql_case_agrees_with_next_wallet_
    // state_on_every_boundary`, asserting the real wallet-credit.sql
    // statement produces the identical state for each row.
    const table: Array<{ balanceMinor: number; expected: WalletState }> = [
      { balanceMinor: MAX_RATE - 1, expected: 'empty' },
      { balanceMinor: MAX_RATE, expected: 'low' },
      { balanceMinor: LOW_THRESHOLD - 1, expected: 'low' },
      { balanceMinor: LOW_THRESHOLD, expected: 'active' },
    ];

    for (const row of table) {
      const result = nextWalletState({
        balanceMinor: row.balanceMinor,
        maxRateMinor: MAX_RATE,
        lowThresholdMinor: LOW_THRESHOLD,
        currentState: 'active',
      });
      expect(result).toBe(row.expected);
    }
  });

  it('every_wallet_state_enum_member_is_reachable_or_absorbing', () => {
    for (const currentState of WALLET_STATES) {
      const result = nextWalletState({
        balanceMinor: 1_000_000,
        maxRateMinor: MAX_RATE,
        lowThresholdMinor: LOW_THRESHOLD,
        currentState,
      });
      expect(result).toBe(currentState === 'frozen' ? 'frozen' : 'active');
    }
  });
});
