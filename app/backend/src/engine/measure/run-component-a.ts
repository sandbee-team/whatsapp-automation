import os from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStoreTestHandles,
  disposeStoreTestHandles,
  cleanupProbeClients,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createMockWaPeer } from './mock-wa-peer.js';
import { createMeasureFleet } from './measure-fleet.js';
import { runRamp, type RampFleet } from '../../../../../scripts/measure/ramp-sessions.js';
import type {
  PgQueryClientLike,
  RedisInfoClientLike,
} from '../../../../../scripts/measure/sampler.js';
import type { HardwareFingerprint } from '../../../../../scripts/measure/artifact.js';

/**
 * run-component-a.ts (P10 Unit U4 - the component-A measurement RUN harness).
 *
 * This is measurement-EXECUTION code, not a tested unit: it wires the real
 * pieces (mock-wa-peer + real EncryptedAuthStore-backed measure-fleet +
 * scripts/measure's runRamp) into one runnable entry, reads the LIVE hardware
 * fingerprint from the host it runs on, and writes the JSONL artifact. It
 * lives under engine/measure/** (NOT scripts/) precisely because it is the ONE
 * place allowed to import both the app-backend fleet AND scripts/measure -
 * scripts/ cannot import app-backend (project boundary + it has no pg/ioredis
 * dep), and production src cannot import engine/measure (the U3
 * dependency-cruiser rule). It is never imported by production code.
 *
 * ADR 0032: the fleet holds real Baileys sockets RESIDENT at the
 * awaited-serverHello stall (no handshake `open` is reachable synthetically);
 * this measures §1.1 rows 1,2,3,7,11,12 as an RSS slope. It must run on Linux
 * (cgroup v2) for the artifact to be publishable - the artifact writer itself
 * refuses a non-Linux / fingerprint-less header.
 *
 * Run (inside the Linux measurement container, with --expose-gc):
 *   node --expose-gc --import tsx app/backend/src/engine/measure/run-component-a.ts \
 *     --ramp 50,250,1000,2000 --planned 50,250,1000,2500 \
 *     --settle-ms 300000 --soak-ms 1200000 --sample-ms 5000 \
 *     --out docs/measurements/raw/<date>-componentA-idle.jsonl
 * Ramp points, windows and the planned (pre-truncation) set are ALL flags so a
 * time-boxed session run records shortened windows HONESTLY in the header
 * rather than faking the full 20-minute soak.
 */

interface CliArgs {
  ramp: number[];
  planned: number[];
  settleMs: number;
  soakMs: number;
  sampleMs: number;
  out: string;
  profile: string;
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        map.set(key, val);
        i += 1;
      } else {
        map.set(key, 'true');
      }
    }
  }
  const nums = (s: string | undefined, fallback: number[]): number[] =>
    s === undefined ? fallback : s.split(',').map((x) => Number(x.trim()));
  const ramp = nums(map.get('ramp'), [50, 250, 1000, 2000]);
  return {
    ramp,
    planned: nums(map.get('planned'), ramp),
    settleMs: Number(map.get('settle-ms') ?? 300_000),
    soakMs: Number(map.get('soak-ms') ?? 1_200_000),
    sampleMs: Number(map.get('sample-ms') ?? 5_000),
    out: map.get('out') ?? `docs/measurements/raw/componentA-${map.get('profile') ?? 'idle'}.jsonl`,
    profile: map.get('profile') ?? 'idle',
  };
}

/** Reads the LIVE hardware fingerprint from the host this process runs on. */
function readHardwareFingerprint(): { hardware: HardwareFingerprint; isLinux: boolean } {
  const cpus = os.cpus();
  const isLinux = process.platform === 'linux';
  let cgroupVersion = 0;
  if (isLinux) {
    // cgroup v2 exposes a unified `cgroup.controllers` file at the mount root;
    // its presence (readable) is the v2 signal. v1 has no such file.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { hardware, isLinux } = readHardwareFingerprint();

  if (!isLinux) {
    // The artifact writer would reject this anyway; fail LOUD and early with
    // the reason so a mistaken host run never looks like a measurement.
    console.error(
      'run-component-a: REFUSING to run on a non-Linux host - cgroup memory.current and ' +
        '/proc/<pid>/stat do not exist here, so the result is not publishable (ADR 0032, ' +
        'P10 "Windows figures are not publishable"). Run inside the Linux measurement container.',
    );
    process.exitCode = 1;
    return;
  }
  if (typeof global.gc !== 'function') {
    console.error(
      'run-component-a: process was not started with --expose-gc; the forced-GC-before-settle ' +
        'step (ADR 0032 / P10 step 4) cannot run. Re-run with `node --expose-gc`.',
    );
    process.exitCode = 1;
    return;
  }

  const handles = createStoreTestHandles();
  const peer = createMockWaPeer({ profile: args.profile === 'idle' ? 'idle' : 'headlessListener' });
  const peerUrl = await peer.start();
  const fleet = createMeasureFleet(handles, { peerUrl, profile: peer.profile() });

  const rampFleet: RampFleet = {
    addSessions: (n: number) => fleet.addSessions(n),
    sessionCount: () => fleet.sessionCount(),
    residentCount: () => fleet.residentCount(),
    forceGc: () => fleet.forceGc(),
  };

  console.log(
    `run-component-a: profile=${args.profile} ramp=[${args.ramp.join(',')}] ` +
      `planned=[${args.planned.join(',')}] settle=${String(args.settleMs)}ms ` +
      `soak=${String(args.soakMs)}ms cpu=${hardware.cpuModel} cores=${String(hardware.cpuCount)} ` +
      `mem=${String(Math.round(hardware.totalMemBytes / 1024 / 1024))}MiB cgv${String(hardware.cgroupVersion)}`,
  );

  try {
    const result = await runRamp({
      fleet: rampFleet,
      pool: handles.pool as unknown as PgQueryClientLike,
      redisSig: handles.redisSig as unknown as RedisInfoClientLike,
      rampPoints: args.ramp,
      plannedRampPoints: args.planned,
      settleMs: args.settleMs,
      soakMs: args.soakMs,
      sampleIntervalMs: args.sampleMs,
      artifactPath: args.out,
      profile: args.profile,
      capturedAtIso: new Date().toISOString(),
      isLinux,
      hardware,
      node: process.version,
      baileysVersion: readBaileysVersion(),
    });
    console.log(
      `run-component-a: DONE. ${String(result.summaries.length)} summary points; ` +
        (result.fit
          ? `slope=${result.fit.slopeMbPerSession.toFixed(3)} MB/session, R²=${result.fit.rSquared.toFixed(4)}, ` +
            `95% CI [${result.fit.slopeCi95.low.toFixed(3)}, ${result.fit.slopeCi95.high.toFixed(3)}] MB`
          : 'no fit (fewer than 4 points)'),
    );
    console.log(`run-component-a: artifact written to ${args.out}`);
  } finally {
    await fleet.teardown();
    await cleanupProbeClients(handles.pool, fleet.clientIds());
    await peer.close();
    await disposeStoreTestHandles(handles);
  }
}

// WARNING 6 (FIX-P10-A): guarded like `check-capacity-gate.ts`/
// `ramp-sessions.ts` - `main()` seeds Postgres rows, binds a WS server, and
// builds up to 2,000 real sockets, so a plain `import` of this module (e.g.
// from a test importing a sibling export) must never trigger a real run.
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  void main();
}
