import { EXPECTED_SCHEMA_VERSION } from '@wp/db';
import { describe, expect, it, vi } from 'vitest';

import {
  assertDbPreconditionsOrExit,
  assertNoZeroMaxRateWallet,
  DefaultPlanMissingError,
  WalletZeroMaxRateError,
} from './assert-db-preconditions.js';
import type { Queryable } from './assert-schema-version.js';
import { PacingStateMissingError } from '../../engine/pacing/provision.js';

/** Default-plan count response for the `SELECT count(*) ... FROM plans WHERE is_default` query - exactly one default plan, the normal boot case. */
const DEFAULT_PLAN_OK = { rows: [{ default_count: 1 }] };

/**
 * Schema OK, then the wallet zero-max-rate query resolves with `rows`, then
 * (for every path that reaches it) the default-plan-count query resolves OK
 * - `assertDbPreconditions` runs schema version, then wallet, then
 * default-plan count, in that order, so any fixture whose wallet response
 * causes the wallet gate to PASS must also answer the default-plan query or
 * the third `db.query` call resolves `undefined` and the test fails with an
 * unrelated `DefaultPlanMissingError`.
 */
function schemaOkThenRows(rows: unknown[]): Queryable {
  const query = vi.fn();
  query.mockResolvedValueOnce({ rows: [{ max_version: EXPECTED_SCHEMA_VERSION }] });
  query.mockResolvedValueOnce({ rows });
  query.mockResolvedValueOnce(DEFAULT_PLAN_OK);
  return { query };
}

function schemaOkThenThrows(err: unknown): Queryable {
  const query = vi.fn();
  query.mockResolvedValueOnce({ rows: [{ max_version: EXPECTED_SCHEMA_VERSION }] });
  query.mockRejectedValueOnce(err);
  return { query };
}

/** Schema OK, wallet OK (zero_count: 0), default-plan count OK, then a fourth call for the pacing-state provisioning scan (`assertNoLiveInstanceIsMissingPacingState`'s one SELECT). `offendingRows` empty = every live instance provisioned. */
function schemaOkWalletOkThenPacingState(
  offendingRows: { instance_id: string; reason: string }[],
): Queryable {
  const query = vi.fn();
  query.mockResolvedValueOnce({ rows: [{ max_version: EXPECTED_SCHEMA_VERSION }] });
  query.mockResolvedValueOnce({ rows: [{ zero_count: 0 }] });
  query.mockResolvedValueOnce(DEFAULT_PLAN_OK);
  query.mockResolvedValueOnce({ rows: offendingRows });
  return { query };
}

/** Schema OK, wallet OK, then the default-plan-count query resolves with `default_count: count`. */
function schemaOkWalletOkThenDefaultPlanCount(count: number): Queryable {
  const query = vi.fn();
  query.mockResolvedValueOnce({ rows: [{ max_version: EXPECTED_SCHEMA_VERSION }] });
  query.mockResolvedValueOnce({ rows: [{ zero_count: 0 }] });
  query.mockResolvedValueOnce({ rows: [{ default_count: count }] });
  return { query };
}

describe('assertNoZeroMaxRateWallet', () => {
  it('boot_fails_if_any_wallet_account_has_a_zero_max_rate', async () => {
    const zeroExists: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [{ zero_count: 2 }] }),
    };
    await expect(assertNoZeroMaxRateWallet(zeroExists)).rejects.toThrow(WalletZeroMaxRateError);

    const db = schemaOkThenRows([{ zero_count: 2 }]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails closed when the wp_zero_max_rate_wallet_count() function is missing or errors', async () => {
    const broken: Queryable = {
      query: vi
        .fn()
        .mockRejectedValue(
          new Error('function public.wp_zero_max_rate_wallet_count() does not exist'),
        ),
    };
    await expect(assertNoZeroMaxRateWallet(broken)).rejects.toThrow(WalletZeroMaxRateError);

    const db = schemaOkThenThrows(new Error('function missing'));
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails closed when zero_count is a non-finite value (NaN/Infinity from a garbage result)', async () => {
    const garbage: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [{ zero_count: 'garbage' }] }),
    };
    await expect(assertNoZeroMaxRateWallet(garbage)).rejects.toThrow(WalletZeroMaxRateError);

    const db = schemaOkThenRows([{ zero_count: 'garbage' }]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails closed when the query returns an empty result set', async () => {
    const empty: Queryable = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(assertNoZeroMaxRateWallet(empty)).rejects.toThrow(WalletZeroMaxRateError);

    const db = schemaOkThenRows([]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails closed when zero_count is NULL', async () => {
    const nullCount: Queryable = {
      query: vi.fn().mockResolvedValue({ rows: [{ zero_count: null }] }),
    };
    await expect(assertNoZeroMaxRateWallet(nullCount)).rejects.toThrow(WalletZeroMaxRateError);

    const db = schemaOkThenRows([{ zero_count: null }]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('resolves when no wallet account has a zero max rate', async () => {
    const clean: Queryable = { query: vi.fn().mockResolvedValue({ rows: [{ zero_count: 0 }] }) };
    await expect(assertNoZeroMaxRateWallet(clean)).resolves.toBeUndefined();

    const db = schemaOkThenRows([{ zero_count: 0 }]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('assertDbPreconditionsOrExit - checkPacingStateProvisioned scoping (session-worker only)', () => {
  it('does not check pacing state by default (api role boot path)', async () => {
    const db = schemaOkThenRows([{ zero_count: 0 }]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(true);
    // Only 3 calls (schema version, wallet check, default-plan count) - the
    // pacing-state scan never ran, so an api-role boot is never blocked by a
    // pacing gap that is a session-worker-only concern.
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('boot_refuses_to_start_when_a_live_instance_has_no_pacing_state (session-worker opt-in)', async () => {
    const db = schemaOkWalletOkThenPacingState([
      { instance_id: 'inst-1', reason: 'missing_state_row' },
    ]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit, { checkPacingStateProvisioned: true });
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('boots clean when every live instance is provisioned and checkPacingStateProvisioned is true', async () => {
    const db = schemaOkWalletOkThenPacingState([]);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit, { checkPacingStateProvisioned: true });
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('the thrown error is PacingStateMissingError', async () => {
    const db = schemaOkWalletOkThenPacingState([
      { instance_id: 'inst-1', reason: 'missing_state_row' },
    ]);
    await expect(
      (async () => {
        const { assertDbPreconditions } = await import('./assert-db-preconditions.js');
        await assertDbPreconditions(db, { checkPacingStateProvisioned: true });
      })(),
    ).rejects.toThrow(PacingStateMissingError);
  });
});

describe('assertDbPreconditionsOrExit - refuses_to_boot_without_exactly_one_default_plan', () => {
  it('refuses to boot when the default-plan count is 0', async () => {
    const db = schemaOkWalletOkThenDefaultPlanCount(0);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('refuses to boot when the default-plan count is 2 (more than one default)', async () => {
    const db = schemaOkWalletOkThenDefaultPlanCount(2);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('boots clean when the default-plan count is exactly 1', async () => {
    const db = schemaOkWalletOkThenDefaultPlanCount(1);
    const exit = vi.fn();
    const ok = await assertDbPreconditionsOrExit(db, exit);
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('the thrown error is DefaultPlanMissingError', async () => {
    const db = schemaOkWalletOkThenDefaultPlanCount(0);
    await expect(
      (async () => {
        const { assertDbPreconditions } = await import('./assert-db-preconditions.js');
        await assertDbPreconditions(db);
      })(),
    ).rejects.toThrow(DefaultPlanMissingError);
  });
});
