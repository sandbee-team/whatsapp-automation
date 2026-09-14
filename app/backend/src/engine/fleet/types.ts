/**
 * types.ts (P09 Unit U2) - shared fleet types that both the admission
 * controller and the (parallel, not-imported-here) sampler/budget/metrics
 * modules need. `WorkerSample` is PRODUCED by a sampler this unit must not
 * import (see the U2 dispatch's hard constraints), so the shape is declared
 * here instead, per the phase's canonical interface.
 */

/** Reuse the repo's `InstanceId` type if `@wp/domain` exports one; none is exported today, so this is a plain `string` alias. */
export type InstanceId = string;

export type AdmissionState = 'accepting' | 'holding' | 'shedding' | 'draining';

export interface WorkerSample {
  readonly sessions: number;
  readonly rssBytes: number;
  readonly heapOldSpaceBytes: number;
  readonly eventLoopLagP99Ms: number;
  readonly gcPauseP99Ms: number;
  /** Monotonic timestamp (e.g. `performance.now()`), never wall-clock. */
  readonly takenAt: number;
}

export interface AdmissionController {
  canAcceptLease(): { ok: boolean; state: AdmissionState; reason?: string };
  /** Fed from a 5s sampler; decisions are made on a 3-sample trend, never a single spike. */
  onSample(s: WorkerSample): void;
  chooseShedVictims(n: number): InstanceId[];
}
