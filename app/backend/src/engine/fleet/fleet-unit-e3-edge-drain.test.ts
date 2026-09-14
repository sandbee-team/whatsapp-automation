import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createDrain, markNeedsReconcile, type DrainDeps, type InFlightEntry } from './drain.js';

/**
 * fleet-unit-e3-edge-drain.test.ts - P09 E3 edge-case pass, unit-level only
 * (no real PG/Redis), split out of `fleet-unit-e3-edge.test.ts` at
 * FIX-P09-B for the max-lines cap (topic split only - same cases,
 * unchanged). Targets drain double-signal/partial-failure edges and
 * markNeedsReconcile replay semantics that drain.test.ts's happy-path suite
 * does not exercise. See `fleet-unit-e3-edge-admission-budget.test.ts` for
 * the admission/budget cases and `fleet-unit-e3-edge-discovery.test.ts` for
 * the discovery escalation/soft-yield cases.
 */

function makeDrainDeps(overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    beginDrain: vi.fn(),
    stopClaiming: vi.fn(async () => undefined),
    inFlight: {
      list: vi.fn((): InFlightEntry[] => []),
      awaitQuiescence: vi.fn(async () => undefined),
    },
    markNeedsReconcile: vi.fn(async () => undefined),
    sessions: [],
    closePools: vi.fn(async () => undefined),
    exit: vi.fn(),
    ...overrides,
  };
}

describe('createDrain - double signal and partial failure edges', () => {
  it('second_run_call_after_a_completed_drain_is_not_prevented_by_the_module_but_wiring_owns_single_invocation_and_exit_is_still_called_once_per_run', async () => {
    // createDrain itself has no internal "already ran" latch - the caller
    // (SIGTERM/SIGINT wiring) is documented as owning single-invocation
    // discipline. This test pins the CURRENT behavior precisely (a second
    // .run() call executes the full sequence again) so a future wiring
    // change that assumes idempotency here is caught, not silently trusted.
    const exit = vi.fn();
    const beginDrain = vi.fn();
    const deps = makeDrainDeps({ exit, beginDrain });
    const drain = createDrain(deps);

    await drain.run();
    await drain.run();

    expect(beginDrain).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenNthCalledWith(1, 0);
    expect(exit).toHaveBeenNthCalledWith(2, 0);
  });

  it('one_sessions_releaseLease_rejecting_does_not_block_the_remaining_sessions_release_or_exit', async () => {
    const calls: string[] = [];
    const failing = {
      instanceId: 'inst-fail',
      flushCreds: vi.fn(async () => {
        calls.push('flushCreds:inst-fail');
      }),
      endSocket: vi.fn(() => {
        calls.push('endSocket:inst-fail');
      }),
      releaseLease: vi.fn(async () => {
        calls.push('releaseLease:inst-fail');
        throw new Error('release rejected');
      }),
    };
    const healthy = {
      instanceId: 'inst-ok',
      flushCreds: vi.fn(async () => {
        calls.push('flushCreds:inst-ok');
      }),
      endSocket: vi.fn(() => {
        calls.push('endSocket:inst-ok');
      }),
      releaseLease: vi.fn(async () => {
        calls.push('releaseLease:inst-ok');
      }),
    };
    const errorLog = vi.fn();
    const exit = vi.fn();

    const deps = makeDrainDeps({
      sessions: [failing, healthy],
      exit,
      logger: { error: errorLog },
    });
    const drain = createDrain(deps);
    await drain.run();

    // Both sessions' full flush->end->release chain ran, in order, despite
    // the first one's releaseLease throwing.
    expect(calls).toEqual([
      'flushCreds:inst-fail',
      'endSocket:inst-fail',
      'releaseLease:inst-fail',
      'flushCreds:inst-ok',
      'endSocket:inst-ok',
      'releaseLease:inst-ok',
    ]);
    expect(errorLog).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('markNeedsReconcile - replay semantics (pure predicate proof over a fake TenantQueryable)', () => {
  it('second_call_after_the_row_already_transitioned_is_a_zero_row_no_op', async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const fakeTx = {
      query: vi.fn(async (text: string, params: unknown[]) => {
        queries.push({ text, params });
        return { rows: [] }; // simulates: row no longer matches status='processing'
      }),
    };

    await markNeedsReconcile(fakeTx as never, {
      jobId: 'job-1',
      instanceId: 'inst-1',
      clientId: 'client-1',
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/status = 'processing'/);
    // No throw, no second write attempted internally - the function issues
    // exactly one conditional UPDATE and returns regardless of row count.
  });

  it('job_already_queued_not_processing_is_never_touched_by_construction_of_the_where_clause', async () => {
    const fakeTx = {
      query: vi.fn(async (text: string) => {
        // The predicate itself excludes 'queued' - this fake proves the
        // exact SQL text carries the status='processing' guard so a
        // 'queued' row can never match, without needing a real DB.
        expect(text).toContain("status = 'processing'");
        return { rows: [] };
      }),
    };

    await markNeedsReconcile(fakeTx as never, {
      jobId: 'job-2',
      instanceId: 'inst-2',
      clientId: 'client-2',
    });

    expect(fakeTx.query).toHaveBeenCalledTimes(1);
  });
});
