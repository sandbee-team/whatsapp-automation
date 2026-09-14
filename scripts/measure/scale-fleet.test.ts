import { describe, expect, test } from 'vitest';
import {
  spreadInstances,
  validatePlan,
  parseChildMessage,
  parseParentMessage,
  readyDeadlineMs,
  assignDeadlineMs,
  drainDeadlineMs,
  statsDeadlineMs,
  type ScaleFleetPlan,
} from './scale-fleet.js';

/**
 * scale-fleet.test.ts (P26 U2a) - the PURE half of the scale-fleet harness:
 * round-robin spread math, plan validation, and the IPC message parser. No
 * pg/ioredis/app-backend import here (scripts/ cannot import app/backend) -
 * see scale-fleet.ts's own module header for the process-boundary story this
 * pure module feeds.
 */

describe('spreadInstances', () => {
  test('spread_is_deterministic_and_exhaustive', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const spread = spreadInstances(ids, 3);

    expect(spread).toEqual([
      ['a', 'd', 'g'],
      ['b', 'e'],
      ['c', 'f'],
    ]);

    // Exhaustive: every id appears exactly once across all workers.
    const flat = spread.flat();
    expect(flat.length).toBe(ids.length);
    expect(new Set(flat).size).toBe(ids.length);
    for (const id of ids) {
      expect(flat).toContain(id);
    }

    // Deterministic: re-running produces byte-identical output.
    expect(spreadInstances(ids, 3)).toEqual(spread);
  });

  test('spread_throws_named_error_on_non_positive_worker_count', () => {
    expect(() => spreadInstances(['a'], 0)).toThrow(/workerCount/);
    expect(() => spreadInstances(['a'], -1)).toThrow(/workerCount/);
  });

  test('spread_handles_more_workers_than_instances', () => {
    const spread = spreadInstances(['a', 'b'], 5);
    expect(spread).toEqual([['a'], ['b'], [], [], []]);
  });
});

describe('validatePlan', () => {
  const basePlan: ScaleFleetPlan = {
    workers: 2,
    instancesPerWorker: 3,
    tenants: 2,
    sessionCap: 10,
  };

  test('valid_plan_does_not_throw', () => {
    expect(() => validatePlan(basePlan)).not.toThrow();
  });

  test('workers_must_be_at_least_one', () => {
    expect(() => validatePlan({ ...basePlan, workers: 0 })).toThrow(/workers/);
  });

  test('instances_per_worker_must_be_at_least_one', () => {
    expect(() => validatePlan({ ...basePlan, instancesPerWorker: 0 })).toThrow(
      /instancesPerWorker/,
    );
  });

  test('instances_per_worker_must_not_exceed_session_cap', () => {
    expect(() => validatePlan({ ...basePlan, instancesPerWorker: 11, sessionCap: 10 })).toThrow(
      /sessionCap/,
    );
  });
});

describe('parseChildMessage', () => {
  test('parser_accepts_every_message_kind', () => {
    const messages: unknown[] = [
      { type: 'ready', workerId: 'w1', pid: 123 },
      { type: 'assigned', instanceId: 'i1', acquired: true, tookMs: 12 },
      {
        type: 'stats',
        workerId: 'w1',
        pid: 123,
        rssBytes: 1,
        heapUsedBytes: 1,
        sessions: 1,
        sendsOk: 0,
        sendsFailed: 0,
        claimIterations: 0,
        atMs: 1,
      },
      { type: 'drained', exitCode: 0 },
    ];
    for (const msg of messages) {
      expect(parseChildMessage(msg)).toEqual(msg);
    }
  });

  test('parser_rejects_garbage_and_never_throws', () => {
    expect(parseChildMessage(null)).toBeNull();
    expect(parseChildMessage(undefined)).toBeNull();
    expect(parseChildMessage('nonsense')).toBeNull();
    expect(parseChildMessage(42)).toBeNull();
    expect(parseChildMessage({})).toBeNull();
    expect(parseChildMessage({ type: 'unknown-kind' })).toBeNull();
    expect(parseChildMessage({ type: 'ready', workerId: 'w1' })).toBeNull(); // missing pid
    expect(() => parseChildMessage(Symbol('x'))).not.toThrow();
  });
});

describe('readyDeadlineMs', () => {
  test('scales_with_instances_per_worker_above_the_floor', () => {
    expect(readyDeadlineMs(100)).toBe(100_000);
  });

  test('never_drops_below_the_60s_floor_for_small_plans', () => {
    expect(readyDeadlineMs(3)).toBe(60_000);
  });

  test('honours_a_custom_floor_and_multiplier', () => {
    expect(readyDeadlineMs(100, { readyFloorMs: 10_000, readyPerInstanceMs: 500 })).toBe(50_000);
    expect(readyDeadlineMs(1, { readyFloorMs: 10_000, readyPerInstanceMs: 500 })).toBe(10_000);
  });
});

describe('assignDeadlineMs', () => {
  test('scales_with_batch_size_above_the_floor', () => {
    expect(assignDeadlineMs(100)).toBe(200_000);
  });

  test('never_drops_below_the_120s_floor_for_small_batches', () => {
    expect(assignDeadlineMs(1)).toBe(120_000);
  });

  test('honours_a_custom_floor_and_multiplier', () => {
    expect(assignDeadlineMs(100, { assignMinMs: 5_000, assignPerInstanceMs: 100 })).toBe(10_000);
    expect(assignDeadlineMs(1, { assignMinMs: 5_000, assignPerInstanceMs: 100 })).toBe(5_000);
  });
});

describe('drainDeadlineMs', () => {
  test('scales_with_instances_per_worker_above_the_floor', () => {
    expect(drainDeadlineMs(100)).toBe(100_000);
  });

  test('never_drops_below_the_90s_floor_for_small_plans', () => {
    expect(drainDeadlineMs(3)).toBe(90_000);
  });

  test('honours_a_custom_floor_and_multiplier', () => {
    expect(drainDeadlineMs(100, { drainFloorMs: 1_000, drainPerInstanceMs: 20 })).toBe(2_000);
    expect(drainDeadlineMs(1, { drainFloorMs: 1_000, drainPerInstanceMs: 20 })).toBe(1_000);
  });
});

describe('statsDeadlineMs', () => {
  test('defaults_to_30_seconds', () => {
    expect(statsDeadlineMs()).toBe(30_000);
  });

  test('honours_a_custom_value', () => {
    expect(statsDeadlineMs({ statsMs: 5_000 })).toBe(5_000);
  });
});

describe('parseParentMessage', () => {
  test('parser_accepts_every_parent_message_kind', () => {
    const messages: unknown[] = [
      { type: 'assign', instances: [{ instanceId: 'i1', clientId: 'c1' }] },
      { type: 'drain' },
      { type: 'stats-request' },
    ];
    for (const msg of messages) {
      expect(parseParentMessage(msg)).toEqual(msg);
    }
  });

  test('parser_rejects_garbage_and_never_throws', () => {
    expect(parseParentMessage(null)).toBeNull();
    expect(parseParentMessage({ type: 'assign', instances: [{ instanceId: 'i1' }] })).toBeNull();
    expect(parseParentMessage({ type: 'assign', instances: 'nope' })).toBeNull();
    expect(parseParentMessage({ type: 'unknown' })).toBeNull();
    expect(() => parseParentMessage(Symbol('x'))).not.toThrow();
  });
});
