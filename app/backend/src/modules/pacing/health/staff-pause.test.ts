import { describe, expect, it, vi } from 'vitest';

/**
 * staff-pause.test.ts (C1 review round 2 MINOR fix) - `staffPause` must
 * never set the `wp_instance_health_state` gauge itself: it runs inside the
 * CALLER's transaction, and a gauge write there would observe a `'paused'`
 * state that has not committed yet - if the surrounding `withStaffMutation`
 * transaction later rolls back (e.g. the audit UPDATE or a sibling write
 * fails), the gauge would keep lying `'paused'` until some unrelated future
 * transition happened to correct it. The caller (`routes/instances.ts`)
 * sets the gauge in `tx.afterCommit`, mirroring the resume route's own
 * `tx.afterCommit(() => ctx.deps.publishWake(...))` deferral.
 */

const setInstanceHealthStateGauge = vi.fn();
vi.mock('./metrics.js', () => ({ setInstanceHealthStateGauge }));

function fakeTx(rowCount = 1) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount });
  return { query };
}

describe('staffPause', () => {
  it('never_sets_the_health_gauge_itself_even_when_it_changes_the_row', async () => {
    const { staffPause } = await import('./staff-pause.js');
    const tx = fakeTx(1);

    const result = await staffPause(tx, {
      clientId: 'client-1',
      instanceId: 'instance-1',
      staffId: 'staff-1',
    });

    expect(result.changed).toBe(true);
    expect(setInstanceHealthStateGauge).not.toHaveBeenCalled();
  });

  it('reports_changed_false_and_still_never_touches_the_gauge_on_a_no_op', async () => {
    const { staffPause } = await import('./staff-pause.js');
    const tx = fakeTx(0);

    const result = await staffPause(tx, {
      clientId: 'client-1',
      instanceId: 'instance-1',
      staffId: 'staff-1',
    });

    expect(result.changed).toBe(false);
    expect(setInstanceHealthStateGauge).not.toHaveBeenCalled();
  });
});
