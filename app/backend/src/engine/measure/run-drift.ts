import os from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerformanceObserver } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  createStoreTestHandles,
  disposeStoreTestHandles,
  cleanupProbeClients,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createMockWaPeer } from './mock-wa-peer.js';
import { createMeasureFleet } from './measure-fleet.js';
import {
  runDriftSoak,
  createDriftArtifactWriter,
  DRIFT_BANNER,
  type DriftRunHeader,
  type DriftFleet,
} from '../../../../../scripts/measure/drift-run.js';
import {
  createSampler,
  createCpuPctReader,
  readCgroupCurrentBytesReal,
  type PgQueryClientLike,
  type RedisInfoClientLike,
} from '../../../../../scripts/measure/sampler.js';
import type { HardwareFingerprint } from '../../../../../scripts/measure/artifact.js';
import {
  readGcStatsReal,
  readNetDevBytesReal,
} from '../../../../../scripts/measure/drift-readers.js';

/**
 * run-drift.ts (P26 Unit U3, step 3 - the 7-day drift-run harness, M6 + M13).
 *
 * Mirrors `run-component-a.ts`'s shape: measurement-EXECUTION code, not a
 * tested unit, wiring the real mock-wa-peer + real EncryptedAuthStore-backed
 * measure-fleet + `scripts/measure`'s `runDriftSoak` into one runnable entry.
 * Lives under engine/measure/** for the same dependency-cruiser reason as
 * `run-component-a.ts` (the one leaf allowed to import both app-backend and
 * scripts/measure).
 *
 * NO forced GC anywhere - a leak test must see production-like heap behaviour
 * (`--expose-gc` is NOT required, unlike run-component-a.ts).
 *
 * Run (inside the Linux measurement container):
 *   node --import tsx app/backend/src/engine/measure/run-drift.ts \
 *     --sessions 1000 --hours 168 --sample-ms 3600000 --settle-ms 300000 \
 *     --profile idle --out docs/measurements/raw/<date>-drift-idle.jsonl \
 *     --header-copy docs/measurements/<date>-drift-header.json \
 *     --note "sysctl net.core.somaxconn=..." --note "concurrent P26 runs: load/pacing/chaos"
 */

interface CliArgs {
  sessions: number;
  hours: number;
  sampleMs: number;
  settleMs: number;
  profile: string;
  out: string;
  headerCopy: string;
  notes: string[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): CliArgs {
  const notes: string[] = [];
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      const hasVal = val !== undefined && !val.startsWith('--');
      if (key === 'note' && hasVal) {
        notes.push(val as string);
        i += 1;
        continue;
      }
      if (hasVal) {
        map.set(key, val as string);
        i += 1;
      } else {
        map.set(key, 'true');
      }
    }
  }
  const date = todayIso();
  return {
    sessions: Number(map.get('sessions') ?? 1000),
    hours: Number(map.get('hours') ?? 168),
    sampleMs: Number(map.get('sample-ms') ?? 3_600_000),
    settleMs: Number(map.get('settle-ms') ?? 300_000),
    profile: map.get('profile') ?? 'idle',
    out: map.get('out') ?? `docs/measurements/raw/${date}-drift-idle.jsonl`,
    headerCopy: map.get('header-copy') ?? `docs/measurements/${date}-drift-header.json`,
    notes,
  };
}

/** Reads the LIVE hardware fingerprint from the host this process runs on (same idiom as run-component-a.ts). */
function readHardwareFingerprint(): { hardware: HardwareFingerprint; isLinux: boolean } {
  const cpus = os.cpus();
  const isLinux = process.platform === 'linux';
  let cgroupVersion = 0;
  if (isLinux) {
    try {
      readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8');
      cgroupVersion = 2;
    } catch {
      cgroupVersion = 1;
    }
  }
  return {
    isLinux,
    hardware: {
      cpuModel: cpus[0]?.model.trim() ?? 'unknown',
      cpuCount: cpus.length,
      totalMemBytes: os.totalmem(),
      kernel: os.release(),
      cgroupVersion,
    },
  };
}

/** Reads the pinned Baileys version from app/backend/package.json (never guessed). */
function readBaileysVersion(): string {
  const pkgPath = resolve(process.cwd(), 'app/backend/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies?.baileys ?? 'unknown';
}

/** Node's max timer delay - `setTimeout`/socket timeouts silently no-op past this (32-bit signed ms). */
const MAX_NODE_TIMER_MS = 2_147_483_647;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { hardware, isLinux } = readHardwareFingerprint();

  if (!isLinux) {
    console.error(
      'run-drift: REFUSING to run on a non-Linux host - cgroup memory.current and ' +
        '/proc/<pid>/stat do not exist here, so the result is not publishable (ADR 0032, ' +
        'P26 M6). Run inside the Linux measurement container.',
    );
    process.exitCode = 1;
    return;
  }

  // The default 30-min connectTimeoutMs (measure-fleet.ts) would tear every
  // socket down mid-week; raise it to cover the whole planned window plus a
  // day of margin, capped at Node's max timer value.
  const computedConnectTimeoutMs = (args.hours + 24) * 3_600_000;
  const connectTimeoutMs = Math.min(computedConnectTimeoutMs, MAX_NODE_TIMER_MS);
  const notes = [...args.notes];
  if (computedConnectTimeoutMs > MAX_NODE_TIMER_MS) {
    notes.push(
      `connectTimeoutMs capped at Node's max timer (${String(MAX_NODE_TIMER_MS)}ms) - ` +
        `computed (hours+24)*3600000 = ${String(computedConnectTimeoutMs)}ms exceeded it.`,
    );
  }

  const handles = createStoreTestHandles();
  const peer = createMockWaPeer({ profile: args.profile === 'idle' ? 'idle' : 'headlessListener' });
  const peerUrl = await peer.start();
  const fleet = createMeasureFleet(handles, { peerUrl, profile: peer.profile(), connectTimeoutMs });

  const driftFleet: DriftFleet = {
    addSessions: (n: number) => fleet.addSessions(n),
    sessionCount: () => fleet.sessionCount(),
    residentCount: () => fleet.residentCount(),
  };

  const eventLoopDelayHistogram = monitorEventLoopDelay();
  eventLoopDelayHistogram.enable();
  const cpuPctReader = createCpuPctReader();

  let lastGcDurations: number[] = [];
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      lastGcDurations.push(entry.duration);
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });

  const sampler = createSampler({
    now: () => Date.now(),
    getSessions: () => fleet.sessionCount(),
    readRssBytes: () => process.memoryUsage().rss,
    readCgroupCurrentBytes: readCgroupCurrentBytesReal,
    readHeapStats: () => {
      const mem = process.memoryUsage();
      return { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external };
    },
    eventLoopDelayHistogram: {
      percentile: (p: number) => eventLoopDelayHistogram.percentile(p) / 1e6,
    },
    readCpuPct: cpuPctReader,
    batchAddMs: { percentile: () => null },
    redisSig: handles.redisSig as unknown as RedisInfoClientLike,
    pg: handles.pool as unknown as PgQueryClientLike,
    isLinux: true,
  });

  const header: DriftRunHeader = {
    kind: 'header',
    schemaVersion: 1,
    runKind: 'drift',
    capturedAtIso: new Date().toISOString(),
    profile: args.profile,
    sessions: args.sessions,
    plannedHours: args.hours,
    sampleIntervalMs: args.sampleMs,
    hardware,
    node: process.version,
    baileysVersion: readBaileysVersion(),
    banner: DRIFT_BANNER,
    isLinux,
    realNumberCohort: 0,
    forcedGc: false,
    notes,
  };

  const writer = createDriftArtifactWriter(args.out, header, args.headerCopy);

  const stopSignal = { stopped: false };
  const stop = (): void => {
    stopSignal.stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  console.log(
    `run-drift: sessions=${String(args.sessions)} hours=${String(args.hours)} ` +
      `sample-ms=${String(args.sampleMs)} profile=${args.profile} connectTimeoutMs=${String(connectTimeoutMs)} ` +
      `cpu=${hardware.cpuModel} cores=${String(hardware.cpuCount)}`,
  );

  try {
    const result = await runDriftSoak({
      fleet: driftFleet,
      sampler,
      readGc: () => {
        const stats = readGcStatsReal(lastGcDurations);
        lastGcDurations = [];
        return stats;
      },
      readNet: readNetDevBytesReal,
      sleep: (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
      now: () => Date.now(),
      writer,
      sessions: args.sessions,
      plannedHours: args.hours,
      sampleIntervalMs: args.sampleMs,
      settleMs: args.settleMs,
      stopSignal,
      onSample: (row) => {
        console.log(
          `hour=${String(row.hourIndex)} resident=${String(row.resident)}/${String(row.sessions)} ` +
            `rss=${(row.rssBytes / 1024 / 1024).toFixed(1)}MiB heapUsed=${(row.heapUsed / 1024 / 1024).toFixed(1)}MiB ` +
            `lagP99=${row.lagP99.toFixed(2)}ms degraded=${String(row.degraded)}`,
        );
      },
    });
    console.log(
      `run-drift: DONE. ${String(result.rowsWritten)} rows written, ${String(result.degradedRows)} degraded.`,
    );
    console.log(`run-drift: artifact written to ${args.out}`);
  } finally {
    await fleet.teardown();
    await cleanupProbeClients(handles.pool, fleet.clientIds());
    await peer.close();
    await disposeStoreTestHandles(handles);
  }
}

// Guarded like run-component-a.ts (WARNING 6) - main() seeds Postgres rows,
// binds a WS server, and builds up to 1,000 real sockets, so a plain
// `import` of this module must never trigger a real run.
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  void main();
}
