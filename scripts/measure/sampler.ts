/**
 * scripts/measure/sampler.ts (P10 Unit U3, step 3) - the measurement
 * sampler: on each `sampleOnce()` tick, reads every injected source and
 * returns one `SampleRow`. This is a SEPARATE, higher-fidelity sampler from
 * the production fleet sampler (`app/backend/src/engine/fleet/sampler.ts`) -
 * it is never imported by that module or by any production `src` code (see
 * the `.dependency-cruiser.cjs` src-isolation rule this same unit adds).
 *
 * Every reader is dependency-injected (fs, redis, pg, clock, process-level
 * getters) so this module is unit-testable with fakes and does zero real
 * I/O under test. `scripts/` is allowed Node builtins directly, but the
 * injected clock is still mandatory here - sampler LOGIC never calls
 * `Date.now()` itself, so a fake-clock unit test stays fully deterministic.
 *
 * DOCUMENTED CHOICES (task spec asks each reader to document its source):
 *
 * - `redisSigBytes`: `INFO memory`'s `used_memory` field on the caller's
 *   `redisSig` connection (a connection already dedicated to the sig tier -
 *   see `platform/redis.ts#resolveSigRedisUrl`), NOT a `MEMORY USAGE` scan
 *   over every `wp:sig:*` key. A per-key `MEMORY USAGE` scan is O(keys) per
 *   tick and would itself distort the very RSS/CPU measurement this sampler
 *   exists to take once the ramp reaches thousands of keys. Because
 *   redis-sig is a SEPARATE service/connection from redis-ctl/redis-cache in
 *   this repo's topology (ADR 0018 §5; `resolveSigRedisUrl` documents the
 *   split), `INFO memory`'s `used_memory` on that dedicated connection
 *   already isolates our keyspace without per-key enumeration.
 *
 * - `pgWriteRowsPerSec`: the delta, over the tick, of
 *   `SELECT sum(n_tup_ins + n_tup_upd) FROM pg_stat_user_tables`, divided by
 *   the wall-clock seconds elapsed since the previous sample. Chosen over
 *   `pg_stat_database`'s `tup_inserted`/`tup_updated` (coarser: whole-
 *   database, would fold in unrelated concurrent activity on a shared dev
 *   Postgres) - `pg_stat_user_tables` is scoped to this schema's own tables.
 *   The FIRST sample of a run has no prior value to diff against, so its
 *   `pgWriteRowsPerSec` is `null` (never a fabricated rate from nothing).
 */

export interface SampleRow {
  ts: number;
  sessions: number;
  rssBytes: number;
  /** `/sys/fs/cgroup/memory.current` (Linux cgroup v2) - `null` off-Linux. */
  cgroupCurrent: number | null;
  heapUsed: number;
  heapTotal: number;
  external: number;
  lagP50: number;
  lagP99: number;
  /** `/proc/<pid>/stat` utime+stime delta over the wall-clock delta - `null` off-Linux. */
  cpuPct: number | null;
  /**
   * WARNING 5 (FIX-P10-A): renamed from `connectMsP50` - this is the
   * cumulative wall-clock duration of one ramp point's whole sequential
   * `addSessions(delta)` batch-build loop (one sample per ramp point, ~20
   * ms/socket at this repo's measured rate), NOT a per-socket connect
   * latency. No per-socket connect/handshake latency was measured this
   * session (carried to P26/M5) - see `ramp-sessions.ts`'s own doc comment.
   */
  batchAddMsP50: number | null;
  /** See `batchAddMsP50`'s doc comment - same caveat, 99th percentile. */
  batchAddMsP99: number | null;
  redisSigBytes: number | null;
  pgWriteRowsPerSec: number | null;
}

/** A minimal view of `perf_hooks.monitorEventLoopDelay()`'s histogram - real or fake. */
export interface EventLoopDelayHistogramLike {
  percentile(p: number): number;
}

/** A minimal view of an `ioredis`-shaped client - real or fake. */
export interface RedisInfoClientLike {
  info(section: string): Promise<string>;
}

/** A minimal view of a `pg`-shaped pool/client - real or fake. */
export interface PgQueryClientLike {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * A batch-add-duration histogram the ramp runner feeds (WARNING 5,
 * FIX-P10-A: renamed from `ConnectLatencyReaderLike` - this reads
 * cumulative BATCH-BUILD durations, one sample per ramp point covering the
 * whole sequential `addSessions(delta)` loop, NOT per-socket connect
 * latency; see `SampleRow.batchAddMsP50`'s doc comment).
 */
export interface BatchAddMsReaderLike {
  percentile(p: number): number | null;
}

export interface SamplerDeps {
  now: () => number;
  getSessions: () => number;
  readRssBytes: () => number;
  /** Returns `null` off-Linux (no `/sys/fs/cgroup/memory.current`). */
  readCgroupCurrentBytes: () => number | null;
  readHeapStats: () => { heapUsed: number; heapTotal: number; external: number };
  eventLoopDelayHistogram: EventLoopDelayHistogramLike;
  /** Returns `null` off-Linux (no `/proc/<pid>/stat`). */
  readCpuPct: (deltaMs: number) => number | null;
  batchAddMs: BatchAddMsReaderLike;
  redisSig: RedisInfoClientLike;
  pg: PgQueryClientLike;
  isLinux: boolean;
}

/** Parses `used_memory:<n>` out of a Redis `INFO memory` string reply. */
export function parseUsedMemoryBytes(infoText: string): number | null {
  const match = /^used_memory:(\d+)/m.exec(infoText);
  if (!match) return null;
  return Number(match[1]);
}

async function readRedisSigBytes(redisSig: RedisInfoClientLike): Promise<number | null> {
  try {
    const info = await redisSig.info('memory');
    return parseUsedMemoryBytes(info);
  } catch {
    return null;
  }
}

async function readPgWriteRowSum(pg: PgQueryClientLike): Promise<number | null> {
  try {
    const result = await pg.query(
      'SELECT coalesce(sum(n_tup_ins + n_tup_upd), 0)::bigint AS total FROM pg_stat_user_tables',
    );
    const row = result.rows[0];
    if (!row) return null;
    return Number(row.total);
  } catch {
    return null;
  }
}

export interface Sampler {
  sampleOnce(): Promise<SampleRow>;
}

/**
 * Builds a sampler. The caller owns the tick interval (this module starts no
 * timer of its own, keeping it trivially testable) - each `sampleOnce()`
 * call reads every injected source and returns one row. `pgWriteRowsPerSec`
 * is `null` on the very first call (nothing to diff against yet).
 */
export function createSampler(deps: SamplerDeps): Sampler {
  let lastPgTotal: number | null = null;
  let lastPgTs: number | null = null;

  return {
    async sampleOnce(): Promise<SampleRow> {
      const ts = deps.now();
      const sessions = deps.getSessions();
      const rssBytes = deps.readRssBytes();
      const cgroupCurrent = deps.isLinux ? deps.readCgroupCurrentBytes() : null;
      const heap = deps.readHeapStats();
      const lagP50 = deps.eventLoopDelayHistogram.percentile(50);
      const lagP99 = deps.eventLoopDelayHistogram.percentile(99);

      const deltaMs = lastPgTs === null ? 0 : ts - lastPgTs;
      const cpuPct = deps.isLinux ? deps.readCpuPct(deltaMs) : null;

      const batchAddMsP50 = deps.batchAddMs.percentile(50);
      const batchAddMsP99 = deps.batchAddMs.percentile(99);

      const redisSigBytes = await readRedisSigBytes(deps.redisSig);

      const pgTotal = await readPgWriteRowSum(deps.pg);
      let pgWriteRowsPerSec: number | null = null;
      if (pgTotal !== null && lastPgTotal !== null && lastPgTs !== null) {
        const elapsedSec = (ts - lastPgTs) / 1000;
        pgWriteRowsPerSec = elapsedSec > 0 ? (pgTotal - lastPgTotal) / elapsedSec : null;
      }
      if (pgTotal !== null) {
        lastPgTotal = pgTotal;
        lastPgTs = ts;
      }

      return {
        ts,
        sessions,
        rssBytes,
        cgroupCurrent,
        heapUsed: heap.heapUsed,
        heapTotal: heap.heapTotal,
        external: heap.external,
        lagP50,
        lagP99,
        cpuPct,
        batchAddMsP50,
        batchAddMsP99,
        redisSigBytes,
        pgWriteRowsPerSec,
      };
    },
  };
}

// ---------------------------------------------------------------------
// Real (non-Linux-guarded) readers - thin, no logic worth faking twice.
// ---------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

export const IS_LINUX = platform() === 'linux';

/** Reads `/sys/fs/cgroup/memory.current` (Linux cgroup v2). Never called off-Linux by the sampler itself. */
export function readCgroupCurrentBytesReal(): number | null {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

interface CpuStatSnapshot {
  utimeTicks: number;
  stimeTicks: number;
  atMs: number;
}

const CLOCK_TICKS_PER_SEC = 100; // USER_HZ - standard on Linux unless configured otherwise.

/** Builds a `readCpuPct` closure over `/proc/<pid>/stat` (Linux only). */
export function createCpuPctReader(pid: number = process.pid): (deltaMs: number) => number | null {
  let last: CpuStatSnapshot | undefined;

  return (deltaMs: number): number | null => {
    let raw: string;
    try {
      raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // Field 14 = utime, field 15 = stime (1-indexed, space-separated after
    // the closing paren of the comm field, which itself may contain spaces).
    const closeParen = raw.lastIndexOf(')');
    const rest = raw.slice(closeParen + 2).split(' ');
    const utimeTicks = Number(rest[11]);
    const stimeTicks = Number(rest[12]);
    const now: CpuStatSnapshot = { utimeTicks, stimeTicks, atMs: Date.now() };

    if (!last || deltaMs <= 0) {
      last = now;
      return null;
    }

    const dUtime = now.utimeTicks - last.utimeTicks;
    const dStime = now.stimeTicks - last.stimeTicks;
    const cpuMs = ((dUtime + dStime) / CLOCK_TICKS_PER_SEC) * 1000;
    last = now;
    return (cpuMs / deltaMs) * 100;
  };
}
