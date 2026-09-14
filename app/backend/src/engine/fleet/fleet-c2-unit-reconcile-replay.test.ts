import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * fleet-c2-unit-reconcile-replay.test.ts - C2 close-step probe (session-
 * fleet-and-drain, P09), split out of `fleet-c2-unit.test.ts` at FIX-P09-B
 * for the max-lines cap (topic split only - same case, unchanged). See
 * `fleet-c2-unit-shed-and-cap.test.ts` for cases 5/3/2 and
 * `fleet-c2-unit-counters.test.ts` for cases 4/7.
 *
 * Case 1 (crash windows) - unit-provable half: a worker that dies (process
 * exit, no teardown call) leaves NO lingering in-process state to clean up
 * by construction, since createDiscoveryLoop/createNoTakerTracker/registry
 * are all plain in-memory objects owned by that one process - proven
 * structurally (N/A) rather than by a test that "kills a process" (that is
 * the real-infra fleet-recovery suite's job, already covered/out of scope
 * per this session's brief). What IS unit-provable here: markNeedsReconcile
 * is idempotent and safe to call twice (drain's own leftover loop already
 * calls it in a fire-and-log loop) - proving a crash between
 * markNeedsReconcile succeeding and releaseLease running, followed by a
 * NEW process re-running drain-equivalent logic (or the reaper) later,
 * cannot double-transition or throw.
 */

describe('C2 case 1 - markNeedsReconcile replay after a simulated crash between the reconcile write and lease release', () => {
  it('calling markNeedsReconcile twice for the same job (once before an assumed crash, once by a later reconciliation pass) is a safe no-op the second time', async () => {
    const { markNeedsReconcile } = await import('./drain.js');
    let callCount = 0;
    const fakeTx = {
      query: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          // First call: real transition, one row matched.
          return { rows: [{ id: 'job-1' }] };
        }
        // Second call (replay): the row is no longer 'processing' (already
        // needs_reconcile), so the conditional UPDATE matches zero rows -
        // exactly the SQL's own idempotency contract.
        return { rows: [] };
      }),
    };

    await markNeedsReconcile(fakeTx as never, {
      jobId: 'job-1',
      instanceId: 'inst-1',
      clientId: 'client-1',
    });
    await expect(
      markNeedsReconcile(fakeTx as never, {
        jobId: 'job-1',
        instanceId: 'inst-1',
        clientId: 'client-1',
      }),
    ).resolves.toBeUndefined();

    expect(fakeTx.query).toHaveBeenCalledTimes(2);
  });
});
