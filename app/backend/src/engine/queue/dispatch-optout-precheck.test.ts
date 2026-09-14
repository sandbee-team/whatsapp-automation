import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TenantQueryable } from '@wp/db';
import { runOptOutPrecheck } from './dispatch-optout-precheck.js';

/**
 * dispatch-optout-precheck.test.ts (P14 Unit U4, step 4) - unit test over a
 * stubbed `tx`: proves the three pass-through shapes (`@g.us` recipient,
 * null `recipientHash`, `sendOrigin === 'opt_out_confirmation'`) never run
 * the opt-out lookup at all, and that a genuine opted-out contact cancels
 * the job via the SAME lease-guarded UPDATE shape `dispatch.ts`'s own
 * `prepareAndIncrement` uses elsewhere (`WHERE lease_id = $lease AND
 * status = 'processing'`). Real-Postgres end-to-end proof (a claimed job
 * actually cancelled, no send_attempts row, pacing unit refunded) lives in
 * `modules/pacing/optout/registry.integration.test.ts`'s
 * `optout_hard_blocks_at_all_three_points`.
 */

function stubTx(options: { optedOut: boolean; cancelRowCount: number }): {
  tx: TenantQueryable;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx: TenantQueryable = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM opt_outs')) {
        return {
          rows: options.optedOut ? [{ '?column?': 1 }] : [],
          rowCount: options.optedOut ? 1 : 0,
        };
      }
      if (sql.includes('UPDATE message_jobs')) {
        return { rows: [], rowCount: options.cancelRowCount };
      }
      return { rows: [], rowCount: 0 };
    }) as TenantQueryable['query'],
  };
  return { tx, calls };
}

function baseInput(overrides: Partial<Parameters<typeof runOptOutPrecheck>[2]> = {}) {
  return {
    clientId: randomUUID(),
    instanceId: randomUUID(),
    jobId: randomUUID(),
    leaseId: randomUUID(),
    recipientJid: '15550001111@s.whatsapp.net',
    recipientHash: Buffer.from('phone-hash-fixture'),
    sendOrigin: 'api_send' as const,
    ...overrides,
  };
}

describe('runOptOutPrecheck (P14 Unit U4)', () => {
  it('skips_the_lookup_entirely_for_a_group_recipient', async () => {
    const { tx, calls } = stubTx({ optedOut: true, cancelRowCount: 1 });

    const result = await runOptOutPrecheck(
      tx,
      {},
      baseInput({ recipientJid: '123456-group@g.us' }),
    );

    expect(result).toEqual({ cancelled: false });
    expect(calls.some((c) => c.sql.includes('FROM opt_outs'))).toBe(false);
  });

  it('skips_the_lookup_entirely_for_a_null_recipient_hash', async () => {
    const { tx, calls } = stubTx({ optedOut: true, cancelRowCount: 1 });

    const result = await runOptOutPrecheck(tx, {}, baseInput({ recipientHash: null }));

    expect(result).toEqual({ cancelled: false });
    expect(calls.some((c) => c.sql.includes('FROM opt_outs'))).toBe(false);
  });

  it('skips_the_lookup_entirely_for_the_opt_out_confirmation_origin', async () => {
    const { tx, calls } = stubTx({ optedOut: true, cancelRowCount: 1 });

    const result = await runOptOutPrecheck(
      tx,
      {},
      baseInput({ sendOrigin: 'opt_out_confirmation' }),
    );

    expect(result).toEqual({ cancelled: false });
    expect(calls.some((c) => c.sql.includes('FROM opt_outs'))).toBe(false);
  });

  it('passes_through_when_the_recipient_is_not_opted_out', async () => {
    const { tx } = stubTx({ optedOut: false, cancelRowCount: 0 });

    const result = await runOptOutPrecheck(tx, {}, baseInput());

    expect(result).toEqual({ cancelled: false });
  });

  it('cancels_the_job_under_the_held_lease_when_opted_out', async () => {
    const { tx, calls } = stubTx({ optedOut: true, cancelRowCount: 1 });
    const input = baseInput();

    const result = await runOptOutPrecheck(tx, {}, input);

    expect(result).toEqual({ cancelled: true });
    const cancelCall = calls.find((c) => c.sql.includes('UPDATE message_jobs'));
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.sql).toContain("status='cancelled'");
    expect(cancelCall?.sql).toContain("cancel_reason='opt_out'");
    expect(cancelCall?.sql).toContain("pacing_deny_reason='OPT_OUT'");
    expect(cancelCall?.sql).toContain('terminal_at=now()');
    expect(cancelCall?.sql).toContain("WHERE lease_id=$1 AND status='processing'");
    expect(cancelCall?.params).toEqual([input.leaseId, input.jobId, input.clientId]);

    // FINDING 8 FIX (P14 review-fix F2): a pre-send cancel must clear the
    // live lease it still holds (never leave a lease pointing at a terminal
    // row) - lease_owner/lease_id/owner_fence/leased_at/lease_expires_at
    // all cleared, and updated_at stamped, same convention as
    // dispose-job.sql. `pacing_reserved_at` is DELIBERATELY excluded -
    // unlike dispose-job.sql (runs before reserve, no unit consumed), this
    // precheck runs AFTER a unit was consumed, and the post-commit refund's
    // idempotency guard reads `pacing_reserved_at IS NOT NULL AND
    // pacing_refunded_at IS NULL` - clearing it here would silently break
    // the refund.
    expect(cancelCall?.sql).toContain('lease_owner=NULL');
    expect(cancelCall?.sql).toContain('lease_id=NULL');
    expect(cancelCall?.sql).toContain('owner_fence=NULL');
    expect(cancelCall?.sql).toContain('leased_at=NULL');
    expect(cancelCall?.sql).toContain('lease_expires_at=NULL');
    expect(cancelCall?.sql).toContain('updated_at=now()');
    expect(cancelCall?.sql).not.toContain('pacing_reserved_at');
  });

  it('reports_not_cancelled_when_the_lease_was_already_lost', async () => {
    // Opted out, but the lease-guarded UPDATE matches zero rows (another
    // worker's fresh claim already replaced this lease_id) - a normal
    // outcome (ClaimLostBeforeDispatch territory), never a crash here.
    const { tx } = stubTx({ optedOut: true, cancelRowCount: 0 });

    const result = await runOptOutPrecheck(tx, {}, baseInput());

    expect(result).toEqual({ cancelled: false });
  });
});
