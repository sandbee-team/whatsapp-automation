import { describe, expect, it } from 'vitest';
import { createSampler, parseUsedMemoryBytes, type SamplerDeps } from './sampler.js';

/**
 * sampler.test.ts (P10 Unit U3) - pure unit tests over `createSampler` with
 * every reader faked; zero real I/O.
 */

function buildDeps(overrides: Partial<SamplerDeps> = {}): SamplerDeps {
  return {
    now: () => 0,
    getSessions: () => 5,
    readRssBytes: () => 123_456,
    readCgroupCurrentBytes: () => 111_111,
    readHeapStats: () => ({ heapUsed: 1, heapTotal: 2, external: 3 }),
    eventLoopDelayHistogram: { percentile: (p: number) => (p === 50 ? 1.5 : 4.5) },
    readCpuPct: () => 42,
    batchAddMs: { percentile: (p: number) => (p === 50 ? 10 : 20) },
    redisSig: { info: async () => 'used_memory:987654\r\nother:1\r\n' },
    pg: { query: async () => ({ rows: [{ total: '1000' }] }) },
    isLinux: true,
    ...overrides,
  };
}

describe('parseUsedMemoryBytes', () => {
  it('extracts used_memory from an INFO memory reply', () => {
    expect(parseUsedMemoryBytes('# Memory\r\nused_memory:5000\r\nused_memory_human:5K\r\n')).toBe(
      5000,
    );
  });

  it('returns null when used_memory is absent', () => {
    expect(parseUsedMemoryBytes('# Memory\r\nsomething_else:1\r\n')).toBeNull();
  });
});

describe('createSampler', () => {
  it('sampler_reads_every_injected_source_into_one_row', async () => {
    const sampler = createSampler(buildDeps());
    const row = await sampler.sampleOnce();

    expect(row.sessions).toBe(5);
    expect(row.rssBytes).toBe(123_456);
    expect(row.cgroupCurrent).toBe(111_111);
    expect(row.heapUsed).toBe(1);
    expect(row.heapTotal).toBe(2);
    expect(row.external).toBe(3);
    expect(row.lagP50).toBe(1.5);
    expect(row.lagP99).toBe(4.5);
    expect(row.cpuPct).toBe(42);
    expect(row.batchAddMsP50).toBe(10);
    expect(row.batchAddMsP99).toBe(20);
    expect(row.redisSigBytes).toBe(987_654);
    // First sample: nothing to diff the pg write total against yet.
    expect(row.pgWriteRowsPerSec).toBeNull();
  });

  it('sampler_computes_pg_write_rate_as_a_delta_over_the_tick_not_a_running_total', async () => {
    let clockValue = 0;
    let pgTotal = 1000;
    const sampler = createSampler(
      buildDeps({
        now: () => clockValue,
        pg: { query: async () => ({ rows: [{ total: String(pgTotal) }] }) },
      }),
    );

    await sampler.sampleOnce(); // primes lastPgTotal at t=0, total=1000

    clockValue = 2000; // +2s
    pgTotal = 3000; // +2000 rows over 2s => 1000 rows/sec
    const second = await sampler.sampleOnce();

    expect(second.pgWriteRowsPerSec).toBe(1000);
  });

  it('cgroup_and_cpu_readers_are_null_off_linux', async () => {
    const sampler = createSampler(buildDeps({ isLinux: false }));
    const row = await sampler.sampleOnce();

    expect(row.cgroupCurrent).toBeNull();
    expect(row.cpuPct).toBeNull();
  });

  it('redis_and_pg_reader_failures_degrade_to_null_never_throw', async () => {
    const sampler = createSampler(
      buildDeps({
        redisSig: {
          info: async () => {
            throw new Error('boom');
          },
        },
        pg: {
          query: async () => {
            throw new Error('boom');
          },
        },
      }),
    );

    const row = await sampler.sampleOnce();
    expect(row.redisSigBytes).toBeNull();
    expect(row.pgWriteRowsPerSec).toBeNull();
  });
});
