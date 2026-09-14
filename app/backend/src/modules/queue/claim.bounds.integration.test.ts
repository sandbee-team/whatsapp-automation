import { TIMING } from '@wp/domain';
import { describe, expect, it } from 'vitest';
import { claimOne } from './index.js';
import { DEFAULT_CLAIM_INPUT, noQueryCtx } from './__tests__/claim-test-helpers.js';

/**
 * claim.bounds.integration.test.ts (P03 close, split from
 * `claim.edge-cases.integration.test.ts` for file-size, protocol C2) -
 * boundary validation for `claimOne`'s own input guard
 * (`assertValidClaimBounds`): `claimExpiryMs` (non-positive, over-ceiling,
 * non-integer, NaN, and the exact ceiling accepted), proven via a recording
 * stub ctx whose `sql.query` throws if ever called - so a pass here proves
 * rejection happened before any DB round trip, not merely that the DB
 * rejected the row later. No real database connection is needed for this
 * file.
 *
 * FINDING 1 FIX (P13 C1 review): the `ledgerDate` boundary cases
 * (`claimOne_rejects_a_malformed_ledgerDate_before_any_db_round_trip`) were
 * REMOVED, not weakened - `ClaimOneInput.ledgerDate` and its validation no
 * longer exist at all. `pacing_ledger_date` is written back from
 * `reserve-pacing.sql`'s own authoritative `ledger_date` by
 * `send-loop-pacing-claim.ts#claimAndReserve`, never bound by a caller into
 * `claimOne` - see `claim-jobs.sql`'s own header, point 9.
 */

describe('claimOne boundary validation (no DB round trip)', () => {
  it('claimOne_rejects_a_non_positive_or_over_ceiling_claimExpiryMs_before_any_db_round_trip', async () => {
    // A recording stub ctx, no tenant seeding: `sql.query` throws if it is
    // EVER called, so a passing test here proves rejection happened purely
    // from `assertValidClaimBounds` - before any DB round trip - not merely
    // that the DB rejected the row later.
    const ctx = noQueryCtx();

    await expect(
      claimOne(ctx, { instanceId: 'unused', ...DEFAULT_CLAIM_INPUT, claimExpiryMs: 0 }),
    ).rejects.toThrow(/claimExpiryMs/);
    await expect(
      claimOne(ctx, { instanceId: 'unused', ...DEFAULT_CLAIM_INPUT, claimExpiryMs: -1 }),
    ).rejects.toThrow(/claimExpiryMs/);
    await expect(
      claimOne(ctx, {
        instanceId: 'unused',
        ...DEFAULT_CLAIM_INPUT,
        claimExpiryMs: TIMING.claimExpiryMs * 2 + 1,
      }),
    ).rejects.toThrow(/claimExpiryMs/);
    await expect(
      claimOne(ctx, { instanceId: 'unused', ...DEFAULT_CLAIM_INPUT, claimExpiryMs: 1.5 }),
    ).rejects.toThrow(/claimExpiryMs/);
    await expect(
      claimOne(ctx, { instanceId: 'unused', ...DEFAULT_CLAIM_INPUT, claimExpiryMs: Number.NaN }),
    ).rejects.toThrow(/claimExpiryMs/);
  });

  it('claimOne_accepts_claimExpiryMs_at_exactly_the_ceiling_and_proceeds_past_validation', async () => {
    // Exactly `TIMING.claimExpiryMs * 2` must NOT throw the bounds error -
    // it is the inclusive ceiling, not one past it. It may still fail once
    // `assertValidClaimBounds` passes and the stub's `sql.query` runs; that
    // failure (the stub's own error, not a claimExpiryMs message) is itself
    // the proof validation let it through.
    const ctx = noQueryCtx();

    await expect(
      claimOne(ctx, {
        instanceId: 'unused',
        ...DEFAULT_CLAIM_INPUT,
        claimExpiryMs: TIMING.claimExpiryMs * 2,
      }),
    ).rejects.toThrow('claimOne must not query on invalid bounds');
  });
});
