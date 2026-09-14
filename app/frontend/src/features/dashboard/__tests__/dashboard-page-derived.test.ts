import { describe, expect, it } from 'vitest';
import { deriveHasSentMessage, deriveHasWalletFunds } from '../dashboard-derive.js';

/**
 * dashboard-page-derived.test.ts (P26b C1 fix round MAJOR-4/MAJOR-5) - unit
 * tests for the two small pure derivations `DashboardPage` used to compute
 * inline (double-counting today's "sent" total, and treating a `frozen`
 * wallet as funded). Exported so this test proves the EXACT contract without
 * rendering the whole page (narrower + faster - `test-discipline` skill).
 */
describe('deriveHasSentMessage', () => {
  it('is_false_when_workspace_sentToday_is_zero_or_absent', () => {
    expect(deriveHasSentMessage(undefined)).toBe(false);
    expect(deriveHasSentMessage(0)).toBe(false);
  });

  it('is_true_when_workspace_sentToday_is_positive', () => {
    expect(deriveHasSentMessage(1)).toBe(true);
    expect(deriveHasSentMessage(42)).toBe(true);
  });
});

describe('deriveHasWalletFunds', () => {
  it('is_true_only_for_the_active_state', () => {
    expect(deriveHasWalletFunds({ state: 'active' })).toBe(true);
  });

  it.each(['low', 'empty', 'frozen'] as const)('is_false_for_the_%s_state', (state) => {
    expect(deriveHasWalletFunds({ state })).toBe(false);
  });

  it('is_false_while_the_wallet_query_has_no_data_yet', () => {
    expect(deriveHasWalletFunds(undefined)).toBe(false);
  });
});
