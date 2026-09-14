import { describe, expect, it } from 'vitest';
import { JOB_TRANSITIONS, type JobStatus as FsmJobStatus } from '../job/state-machine.js';
import { JOB_STATUSES } from './index.js';

/**
 * Closes the hole where `packages/domain/src/job/state-machine.ts`'s
 * `JobStatus` union and this module's `JOB_STATUSES`/`PgJobStatus` mirror of
 * the Postgres `job_status` enum are two separately-hand-maintained lists
 * with the identical labels today, but nothing stops them drifting apart
 * silently (a new status added to one and not the other). `JOB_TRANSITIONS`
 * is the FSM's authoritative RUNTIME value (a `Record<JobStatus, ...>`), so
 * `Object.keys` on it is the true label set to compare - not a hand-copied
 * literal that could itself drift from the FSM.
 */
describe('job_status enum consistency between @wp/domain job FSM and the pg enum mirror', () => {
  it('job_fsm_status_labels_equal_the_pg_enum_mirror', () => {
    const fsmLabels = Object.keys(JOB_TRANSITIONS) as FsmJobStatus[];

    // Exact order too: both sources document (and depend on) matching the
    // canonical `job_status` Postgres enum's declared order.
    expect(fsmLabels).toEqual([...JOB_STATUSES]);

    // Set-equality as a second, independent lens: catches an order-only
    // fixture mistake in this test itself from masquerading as "in sync".
    expect(new Set(fsmLabels)).toEqual(new Set(JOB_STATUSES));
    expect(fsmLabels.length).toBe(JOB_STATUSES.length);
  });
});
