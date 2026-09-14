import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import {
  GuardPipelineStateInvalidError,
  readGuardPipelineState,
} from './send-loop-guard-pipeline-wiring.js';

/**
 * send-loop-guard-pipeline-wiring.test.ts (P14 review-fix F2, Finding 5) -
 * `readGuardPipelineState` must fail closed (throw) on any non-finite or
 * non-positive threshold/limit, rather than pass a NULL/invalid number
 * through to the guard pipeline and pacing reserve unguarded. Migration 0040
 * now backs this with NOT NULL + CHECK(>0) constraints at the DB layer, but
 * this module must not rely on the constraint alone (defence in depth - a
 * pre-migration row, or a future column this migration didn't cover, must
 * still be caught here). `TenantQueryable` is a plain interface - no
 * `@wp/server-kit` config singleton in the import chain, so no stub-env
 * first-import guard needed.
 */

function makeTx(row: Record<string, unknown> | undefined): TenantQueryable {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) };
}

const VALID_ROW = {
  warmup_tier: 1,
  local_date: '2026-09-02',
  dup_fanout_warn: 150,
  dup_fanout_ack: 500,
  per_recipient_24h: 3,
  per_recipient_7d: 8,
};

describe('readGuardPipelineState - fail-closed threshold validation (Finding 5)', () => {
  it('a_fully_valid_row_resolves_normally', async () => {
    const tx = makeTx(VALID_ROW);
    const state = await readGuardPipelineState(tx, 'client-1', 'instance-1');
    expect(state).toEqual({
      warmupTier: 1,
      localDate: '2026-09-02',
      dupFanoutWarn: 150,
      dupFanoutAck: 500,
      perRecipient24h: 3,
      perRecipient7d: 8,
    });
  });

  it('no_row_resolves_to_undefined_never_throws', async () => {
    const tx = makeTx(undefined);
    await expect(readGuardPipelineState(tx, 'client-1', 'instance-1')).resolves.toBeUndefined();
  });

  it.each([
    ['per_recipient_24h', { ...VALID_ROW, per_recipient_24h: null }],
    ['per_recipient_24h', { ...VALID_ROW, per_recipient_24h: 0 }],
    ['per_recipient_24h', { ...VALID_ROW, per_recipient_24h: Number.NaN }],
    ['per_recipient_7d', { ...VALID_ROW, per_recipient_7d: -1 }],
    ['dup_fanout_warn', { ...VALID_ROW, dup_fanout_warn: 0 }],
    ['dup_fanout_ack', { ...VALID_ROW, dup_fanout_ack: Number.POSITIVE_INFINITY }],
  ])('throws_a_typed_error_naming_the_instance_when_%s_is_invalid', async (_field, row) => {
    const tx = makeTx(row as unknown as Record<string, unknown>);
    await expect(readGuardPipelineState(tx, 'client-9', 'instance-9')).rejects.toBeInstanceOf(
      GuardPipelineStateInvalidError,
    );
    await expect(readGuardPipelineState(tx, 'client-9', 'instance-9')).rejects.toThrow(
      /instance-9/,
    );
  });
});
