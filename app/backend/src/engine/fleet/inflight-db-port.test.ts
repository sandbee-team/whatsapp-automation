import { describe, expect, it, vi } from 'vitest';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { buildDbInFlightPort } from './inflight-db-port.js';
import { createDrain, type DrainDeps, type InFlightEntry } from './drain.js';

/**
 * inflight-db-port.test.ts (launch-checklist row 31, 2026-09-11; C1 fix
 * round) - proves the DB-derived `InFlightPort` scopes strictly to the
 * instances/clients passed in (tenant isolation, invariant 4) via a FAKE
 * `TenantDb` (never a bare pool - see C1 FINDING 1, the RLS regression a bare
 * `pool.query()` reproduced), and that wiring it into `createDrain` marks a
 * leftover in-flight job `needs_reconcile` via the REAL `markNeedsReconcile`
 * semantics - never a blind retry (invariant 2) - while a quiescent worker
 * (zero in-flight rows) proceeds immediately. C1 FINDING 5: no wall-clock
 * margin assertions anywhere in this file - every invariant here is the
 * exact call-count/call-args on the fake, never a sampled elapsed time (see
 * core-invariants.md "Tests must not assert on ambient state"). The real
 * `wp_scheduler`-role RLS proof lives in `inflight-db-port.rls.integration.test.ts`.
 */

interface FakeRow {
  id: string;
  instance_id: string;
  client_id: string;
}

/**
 * A fake `TenantDb`: `withTenant` records the `clientId` it was called with
 * and hands the callback a fake `TenantQueryable` whose `query` returns the
 * next scripted row-set. C1 FINDING 6: returns `[]` PAST the end of the
 * script (never clamps to the last entry) - an unexpected extra poll is a
 * VISIBLE empty result, not a silently-repeated leftover row, so a test can
 * assert an exact call count instead of guessing at one.
 */
function makeFakeTenantDb(rowsByCall: FakeRow[][]): {
  tenantDb: TenantDb;
  withTenantCalls: string[];
  queryCalls: unknown[][];
} {
  const withTenantCalls: string[] = [];
  const queryCalls: unknown[][] = [];
  let callIndex = 0;

  const tenantDb: TenantDb = {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      withTenantCalls.push(clientId);
      const tx: TenantQueryable = {
        query: async (_sql: string, params?: unknown[]) => {
          queryCalls.push(params ?? []);
          const rows = rowsByCall[callIndex] ?? [];
          callIndex += 1;
          return { rows: rows as never[], rowCount: rows.length };
        },
      };
      return fn(tx);
    },
  };

  return { tenantDb, withTenantCalls, queryCalls };
}

describe('buildDbInFlightPort', () => {
  it('scopes_the_query_to_exactly_the_instance_ids_owned_by_each_client_via_withTenant', async () => {
    const fake = makeFakeTenantDb([[]]);
    const port = buildDbInFlightPort(fake.tenantDb, [
      { instanceId: 'inst-a', clientId: 'client-1' },
    ]);

    await port.awaitQuiescence(50);

    expect(fake.withTenantCalls).toEqual(['client-1']);
    expect(fake.queryCalls).toEqual([[['inst-a'], 'client-1']]);
  });

  it('groups_multiple_instances_of_the_same_client_into_one_withTenant_call', async () => {
    const fake = makeFakeTenantDb([[]]);
    const port = buildDbInFlightPort(fake.tenantDb, [
      { instanceId: 'inst-a', clientId: 'client-1' },
      { instanceId: 'inst-b', clientId: 'client-1' },
    ]);

    await port.awaitQuiescence(50);

    expect(fake.withTenantCalls).toEqual(['client-1']);
    expect(fake.queryCalls).toEqual([[['inst-a', 'inst-b'], 'client-1']]);
  });

  it('zero_in_flight_rows_resolves_awaitQuiescence_after_exactly_one_poll_and_list_is_empty', async () => {
    const fake = makeFakeTenantDb([[]]);
    const port = buildDbInFlightPort(fake.tenantDb, [
      { instanceId: 'inst-a', clientId: 'client-1' },
    ]);

    await port.awaitQuiescence(1000);

    // C1 FINDING 5: exactly one poll (no sleep triggered), not an elapsed-time bound.
    expect(fake.queryCalls).toHaveLength(1);
    expect(port.list()).toEqual([]);
  });

  it('a_still_processing_row_at_the_deadline_is_returned_by_list_after_awaitQuiescence', async () => {
    const leftoverRow: FakeRow = { id: 'job-1', instance_id: 'inst-a', client_id: 'client-1' };
    const fake = makeFakeTenantDb([[leftoverRow], [leftoverRow], [leftoverRow]]);
    const port = buildDbInFlightPort(
      fake.tenantDb,
      [{ instanceId: 'inst-a', clientId: 'client-1' }],
      5,
    );

    await port.awaitQuiescence(20);

    expect(port.list()).toEqual([{ jobId: 'job-1', instanceId: 'inst-a', clientId: 'client-1' }]);
  });

  it('list_returns_a_copy_so_mutating_it_cannot_affect_the_next_awaitQuiescence_read', async () => {
    const leftoverRow: FakeRow = { id: 'job-1', instance_id: 'inst-a', client_id: 'client-1' };
    const fake = makeFakeTenantDb([[leftoverRow]]);
    const port = buildDbInFlightPort(fake.tenantDb, [
      { instanceId: 'inst-a', clientId: 'client-1' },
    ]);

    await port.awaitQuiescence(1);
    const first = port.list();
    first.push({ jobId: 'job-injected', instanceId: 'inst-a', clientId: 'client-1' });

    expect(port.list()).toEqual([{ jobId: 'job-1', instanceId: 'inst-a', clientId: 'client-1' }]);
  });

  it('an_already_past_deadline_polls_zero_times', async () => {
    const fake = makeFakeTenantDb([[]]);
    const port = buildDbInFlightPort(fake.tenantDb, [
      { instanceId: 'inst-a', clientId: 'client-1' },
    ]);

    await port.awaitQuiescence(-1);

    // C1 FINDING 3a: the deadline is checked BEFORE issuing each query too.
    expect(fake.queryCalls).toHaveLength(0);
    expect(port.list()).toEqual([]);
  });

  it('wired_into_createDrain_a_leftover_job_still_processing_at_the_deadline_is_marked_needs_reconcile_never_a_blind_requeue', async () => {
    const leftoverRow: FakeRow = { id: 'job-9', instance_id: 'inst-x', client_id: 'client-9' };
    const fake = makeFakeTenantDb([[leftoverRow], [leftoverRow]]);
    const inFlight = buildDbInFlightPort(
      fake.tenantDb,
      [{ instanceId: 'inst-x', clientId: 'client-9' }],
      5,
    );

    const markNeedsReconcile = vi.fn<(entry: InFlightEntry) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const exit = vi.fn();
    const deps: DrainDeps = {
      beginDrain: vi.fn(),
      stopClaiming: vi.fn(async () => undefined),
      inFlight,
      markNeedsReconcile,
      sessions: [],
      closePools: vi.fn(async () => undefined),
      exit,
      deadlines: { inFlightWaitMs: 15, totalMs: 200 },
    };

    const drain = createDrain(deps);
    await drain.run();

    expect(markNeedsReconcile).toHaveBeenCalledTimes(1);
    expect(markNeedsReconcile).toHaveBeenCalledWith({
      jobId: 'job-9',
      instanceId: 'inst-x',
      clientId: 'client-9',
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('wired_into_createDrain_zero_in_flight_jobs_proceeds_without_calling_markNeedsReconcile', async () => {
    const fake = makeFakeTenantDb([[]]);
    const inFlight = buildDbInFlightPort(
      fake.tenantDb,
      [{ instanceId: 'inst-y', clientId: 'client-9' }],
      200,
    );

    const markNeedsReconcile = vi.fn<(entry: InFlightEntry) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const exit = vi.fn();
    const deps: DrainDeps = {
      beginDrain: vi.fn(),
      stopClaiming: vi.fn(async () => undefined),
      inFlight,
      markNeedsReconcile,
      sessions: [],
      closePools: vi.fn(async () => undefined),
      exit,
      deadlines: { inFlightWaitMs: 1000, totalMs: 2000 },
    };

    const drain = createDrain(deps);
    await drain.run();

    // C1 FINDING 5: exactly one poll (no sleep triggered), not an elapsed-time bound.
    expect(fake.queryCalls).toHaveLength(1);
    expect(markNeedsReconcile).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
