import { describe, expect, it } from 'vitest';
import {
  BoxMemoryBudgetExceededError,
  checkBoxMemoryBudget,
  parseWorkerServices,
  runCheckBoxMemory,
  DEFAULT_BOX_RAM_GB,
  DEFAULT_OS_RESERVE_GB,
  PER_WORKER_BASELINE_GB,
  HEADROOM_FACTOR,
} from '../check-box-memory.js';

/**
 * check-box-memory.test.ts (P09 Unit U5, step 8) - `checkBoxMemoryBudget` is
 * a pure function over already-parsed worker service specs (no filesystem
 * access), so the named 15x3.5GB fixture drives it directly. Same
 * `scripts/guards/*.test.ts` convention as the other two P09 guards.
 *
 * Named test pin (phase spec, verbatim): 15 workers x 3.5 GB on a 64 GB box
 * FAILS (52.5 GB > (64-6-3.0)*0.68+3.0 = 40.4 GB) with the named error.
 */

describe('check-box-memory (P09 Unit U5, step 8)', () => {
  it('sum_of_worker_mem_limits_plus_os_reserve_must_fit_box_ram', () => {
    // 15 workers x 3.5 GB on a 64 GB box - the named-pin failure case.
    const workers = Array.from({ length: 15 }, (_, i) => ({
      name: `session-worker-${String(i)}`,
      memLimitGb: 3.5,
      replicas: 1,
    }));

    expect(() => checkBoxMemoryBudget(workers, { boxRamGb: 64, osReserveGb: 6 })).toThrow(
      BoxMemoryBudgetExceededError,
    );

    try {
      checkBoxMemoryBudget(workers, { boxRamGb: 64, osReserveGb: 6 });
      throw new Error('expected checkBoxMemoryBudget to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BoxMemoryBudgetExceededError);
      const message = (err as Error).message;
      // Both sides of the inequality must be stated.
      expect(message).toMatch(/52\.5/);
      expect(message).toMatch(/40\.4/);
    }
  });

  it('a_single_default_worker_fits_comfortably_within_budget', () => {
    const workers = [{ name: 'session-worker', memLimitGb: 3.584, replicas: 1 }];
    expect(() =>
      checkBoxMemoryBudget(workers, {
        boxRamGb: DEFAULT_BOX_RAM_GB,
        osReserveGb: DEFAULT_OS_RESERVE_GB,
      }),
    ).not.toThrow();
  });

  it('defaults_match_the_canonical_budget_constants', () => {
    expect(DEFAULT_BOX_RAM_GB).toBe(64);
    expect(DEFAULT_OS_RESERVE_GB).toBe(6);
    expect(PER_WORKER_BASELINE_GB).toBe(0.2);
    expect(HEADROOM_FACTOR).toBeCloseTo(0.68);
  });

  it('the_weaker_necessary_condition_sum_mem_limit_plus_os_reserve_le_box_ram_is_also_asserted', () => {
    // A pathological case that satisfies the strict headroom form is
    // impossible to construct while violating the weaker necessary
    // condition (the strict form is tighter) - instead pin that a violation
    // of the weaker form is caught even for a tiny worker count.
    const workers = [{ name: 'session-worker', memLimitGb: 60, replicas: 1 }];
    expect(() => checkBoxMemoryBudget(workers, { boxRamGb: 64, osReserveGb: 6 })).toThrow(
      BoxMemoryBudgetExceededError,
    );
  });

  it('replicas_multiply_the_per_service_mem_limit', () => {
    const workers = [{ name: 'session-worker', memLimitGb: 10, replicas: 5 }];
    expect(() => checkBoxMemoryBudget(workers, { boxRamGb: 64, osReserveGb: 6 })).toThrow(
      BoxMemoryBudgetExceededError,
    );
  });

  it('parses_worker_services_from_the_real_dev_compose_file_and_it_passes_at_defaults', () => {
    const result = runCheckBoxMemory();
    expect(result.workers.length).toBeGreaterThan(0);
    expect(() => checkBoxMemoryBudget(result.workers, {})).not.toThrow();
  });

  it('parseWorkerServices_selects_services_whose_name_matches_session_worker', () => {
    const compose = `
services:
  postgres:
    image: postgres:17
    mem_limit: 512m
  session-worker:
    image: node:24
    mem_limit: 3584m
    deploy:
      replicas: 2
`;
    const workers = parseWorkerServices(compose);
    expect(workers).toEqual([{ name: 'session-worker', memLimitGb: 3.5, replicas: 2 }]);
  });
});
