import { describe, expect, it } from 'vitest';
import { canonicalizePartitionTableName } from './grants-canonical.js';

/**
 * P03 close, finding 2 - pure unit coverage for
 * `canonicalizePartitionTableName`. Previously this helper was only
 * exercised indirectly through the live `grants-snapshot.test.ts` DB
 * snapshot, so a regex regression (e.g. the monthly-only pattern that
 * missed `delivery_events`' weekly partition children) had no fast,
 * DB-free test to catch it.
 */
describe('canonicalizePartitionTableName', () => {
  it('collapses a monthly partition child suffix to the yNNNNmNN placeholder', () => {
    expect(canonicalizePartitionTableName('wallet_ledger_y2026m08')).toBe('wallet_ledger_yNNNNmNN');
    expect(canonicalizePartitionTableName('message_jobs_y2032m01')).toBe('message_jobs_yNNNNmNN');
  });

  it('collapses a weekly partition child suffix to the yNNNNwNN placeholder', () => {
    expect(canonicalizePartitionTableName('delivery_events_y2026w35')).toBe(
      'delivery_events_yNNNNwNN',
    );
    expect(canonicalizePartitionTableName('delivery_events_y2026w37')).toBe(
      'delivery_events_yNNNNwNN',
    );
  });

  it('leaves a non-partition-child table name unchanged', () => {
    expect(canonicalizePartitionTableName('message_jobs')).toBe('message_jobs');
    expect(canonicalizePartitionTableName('wallet_ledger_ext_refs')).toBe('wallet_ledger_ext_refs');
  });
});
