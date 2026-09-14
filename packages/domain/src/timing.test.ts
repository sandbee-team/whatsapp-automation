import { describe, expect, it } from 'vitest';
import { TIMING } from './timing.js';

describe('TIMING', () => {
  it('timing_ordering_invariants_hold', () => {
    // [R-33s]: sendTimeout < claimExpiry - reaperGrace - otherwise the
    // reaper could reclaim a lease while a send is still legitimately in
    // flight, racing the send's own timeout.
    expect(TIMING.sendTimeoutMs).toBeLessThan(TIMING.claimExpiryMs - TIMING.reaperGraceMs);

    // takeoverGrace + leaseTtl > watchdog - otherwise a takeover could
    // complete and start a new socket before the old owner's watchdog has
    // had a chance to self-fence, risking two writers.
    expect(TIMING.takeoverGraceMs + TIMING.leaseTtlMs).toBeGreaterThan(TIMING.watchdogMs);

    // redisCommandTimeoutMs must exist and be a hard, fast timeout - a
    // renew attempt must resolve well inside one heartbeat interval, or the
    // watchdog math (self-fence within watchdogMs) no longer holds.
    expect(TIMING.redisCommandTimeoutMs).toBe(2_000);
    expect(TIMING.redisCommandTimeoutMs).toBeLessThan(TIMING.heartbeatMs);

    // pgConnectTimeoutMs/pgStatementTimeoutMs must exist and be sane, fast
    // bounds on the PG leg of the session runner's pool.
    expect(TIMING.pgConnectTimeoutMs).toBe(3_000);
    expect(TIMING.pgStatementTimeoutMs).toBe(5_000);
    expect(TIMING.pgConnectTimeoutMs).toBeLessThan(TIMING.heartbeatMs);
    expect(TIMING.pgStatementTimeoutMs).toBeLessThan(TIMING.leaseTtlMs);

    // P12: the echo-match tolerance is applied on BOTH sides of an evidence
    // row's observed_at (±echoToleranceMs), so twice the tolerance must
    // still fit inside the reconcile evidence window, or a legitimately
    // in-window echo could fall outside the tolerance the reconciler
    // actually applies.
    expect(TIMING.echoToleranceMs * 2).toBeLessThanOrEqual(TIMING.reconcileWindowMs);

    // The reaper must sweep meaningfully faster than its own grace period,
    // or a lease could sit expired-and-unswept for longer than the grace
    // period itself intends.
    expect(TIMING.reaperIntervalMs).toBeLessThan(TIMING.reaperGraceMs);

    // P18 U8b: the reconciler sweep must run at least hourly (it is the
    // fallback correction path for a missed debit/refund), and the wallet
    // charger's drain interval must never be faster than the reaper's own
    // sweep interval - both walk the same crash-recovery class of gap.
    expect(TIMING.walletReconcileIntervalMs).toBeGreaterThanOrEqual(3_600_000);
    expect(TIMING.walletChargerDrainIntervalMs).toBeGreaterThanOrEqual(TIMING.reaperIntervalMs);
  });

  it('timing_is_frozen_a_mutation_attempt_is_rejected_and_the_value_is_unchanged', () => {
    expect(Object.isFrozen(TIMING)).toBe(true);

    // In strict-mode ESM, assigning to a frozen object's property throws
    // rather than silently no-oping - this proves the ordering invariants
    // above cannot be defeated by a later mutation anywhere in the process.
    expect(() => {
      // @ts-expect-error - intentionally violating the readonly/frozen shape
      TIMING.sendTimeoutMs = 1;
    }).toThrow(TypeError);

    expect(TIMING.sendTimeoutMs).toBe(45_000);
  });
});
