import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createPool } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  CHAOS_SCENARIOS,
  validateChaosRunRecord,
  formatChaosRunMarkdown,
  assertFlushTargetAllowed,
  type ChaosRunRecord,
  type ChaosScenario,
} from '../../../../../scripts/chaos/run-chaos.js';
import type { HardwareFingerprint } from '../../../../../scripts/measure/artifact.js';
import { createScaleFleet, type ScaleFleet } from './scale-fleet.js';
import { createMeasureEnqueue } from './measure-enqueue.js';
import { resolveFleetInstances } from './run-pacing-windows.js';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
} from '../session/synthetic-fleet-support.js';
import { runWorkerKill, runRedisFlush, runRollingDeploy } from './run-chaos-fleet-scenarios.js';
import { runPostgresOutageNotRun, type ScenarioContext } from './run-chaos-fleet-reads.js';

/**
 * run-chaos-fleet.ts (P26 U6c, step 6) - the RUNNABLE that executes the step-6
 * chaos drills against a REAL `ScaleFleet` (`scale-fleet.ts`, U2a: real worker
 * child PROCESSES driving the real lease/fence/claim/dispatch path over a
 * FakeSock, never Baileys, never network) at an operator-chosen fleet size,
 * and writes one `ChaosRunRecord` per scenario to a JSON artifact.
 * isMain-guarded, never runs on import - same idiom as `run-pg-load.ts`.
 *
 * The PURE half of the harness (`deployWaveSize`, `assertFlushTargetAllowed`,
 * `CHAOS_SCENARIOS`, the record schema + validator + Markdown formatter) is
 * IMPORTED from `scripts/chaos/run-chaos.ts`, never re-derived. The scenario
 * bodies live in `run-chaos-fleet-scenarios.ts` (max-lines split).
 *
 * EVIDENCE DISCIPLINE (invariant 7): every measurement is read from Postgres
 * ROWS, `fleet.ownerMap()`, `requestStats()` or a real Redis `dbsize` - never
 * a harness running total. `measurements` values stay NUMBERS; the validator
 * rejects pass/fail words there, and the verdict lives in its own field.
 *
 * SAFETY: the only destructive act this runner performs is `FLUSHALL` on the
 * redis-CTL handle, gated by `assertFlushTargetAllowed` (which refuses
 * anything but `redis-ctl` BEFORE any I/O - ADR 0018 S5: flushing redis-sig
 * would destroy non-rebuildable Signal ratchet state). It never stops,
 * restarts or flushes Postgres or any container - a long-running drift run
 * and a pacing smoke may share this box.
 */

interface CliArgs {
  scenario: ChaosScenario | 'all';
  instances: number;
  workers: number;
  sessionsPerWorker: number;
  tenants: number;
  flushTarget: string;
  outcomeDeadlineMs: number;
  /** Queued jobs enqueued per instance (with the real per-job wake) BEFORE any scenario, so the chaos lands on a fleet that is actually sending - `fleet.start()` seeds instances only, never a backlog (C1 finding: `sendsObserved` was structurally 0). */
  jobsPerInstance: number;
  out: string;
}

export class InvalidChaosCliArgsError extends Error {
  constructor(message: string) {
    super(`run-chaos-fleet: ${message}`);
    this.name = 'InvalidChaosCliArgsError';
  }
}

function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        map.set(arg.slice(2), val);
        i += 1;
      }
    }
  }
  const scenario = map.get('scenario') ?? 'all';
  if (scenario !== 'all' && !CHAOS_SCENARIOS.includes(scenario as ChaosScenario)) {
    throw new InvalidChaosCliArgsError(
      `--scenario must be one of ${CHAOS_SCENARIOS.join(', ')}, all - got "${scenario}"`,
    );
  }
  const workers = Number(map.get('workers') ?? 4);
  const sessionsPerWorker = Number(map.get('sessions-per-worker') ?? 6);
  const instances = Number(map.get('instances') ?? workers * sessionsPerWorker);
  const date = new Date().toISOString().slice(0, 10);
  return {
    scenario: scenario as ChaosScenario | 'all',
    instances,
    workers,
    sessionsPerWorker,
    tenants: Number(map.get('tenants') ?? Math.max(1, Math.min(workers, 8))),
    flushTarget: map.get('flush-target') ?? 'redis-ctl',
    outcomeDeadlineMs: Number(map.get('outcome-deadline-ms') ?? 45_000),
    jobsPerInstance: Number(map.get('jobs-per-instance') ?? 5),
    out: map.get('out') ?? `docs/measurements/${date}-chaos-${scenario}.json`,
  };
}

function readHardwareFingerprint(): HardwareFingerprint {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    kernel: os.release(),
    cgroupVersion: process.platform === 'linux' ? 2 : 0,
  };
}

function scenariosToRun(scenario: ChaosScenario | 'all'): ChaosScenario[] {
  return scenario === 'all' ? [...CHAOS_SCENARIOS] : [scenario];
}

async function runOneScenario(
  scenario: ChaosScenario,
  ctx: ScenarioContext,
): Promise<ChaosRunRecord> {
  switch (scenario) {
    case 'worker-kill':
      return runWorkerKill(ctx);
    case 'redis-flush':
      return runRedisFlush(ctx);
    case 'rolling-deploy':
      return runRollingDeploy(ctx);
    case 'postgres-outage':
      return runPostgresOutageNotRun(ctx);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wanted = scenariosToRun(args.scenario);

  // Refuse a forbidden flush target BEFORE standing up any fleet or touching
  // Redis at all - the refusal must never cost real infra work, and must
  // never be reachable after a connection is open.
  if (wanted.includes('redis-flush')) {
    assertFlushTargetAllowed(args.flushTarget);
  }

  const instancesPerWorker = Math.max(
    1,
    Math.ceil(args.instances / Math.max(1, args.workers)) || args.sessionsPerWorker,
  );
  const plan = {
    workers: Math.max(1, args.workers),
    instancesPerWorker,
    tenants: Math.max(1, args.tenants),
    sessionCap: instancesPerWorker + 1,
  };

  // Child TS loader: inherited from THIS parent's TS-capable loader flags, or
  // `--import tsx` (scripts/measure/child-exec-argv.ts). No override is set
  // here - forcing `--import tsx` would crash children inside the Linux
  // container, where only the parent's explicit Linux loader works (C1 MAJOR).

  const handles = createSyntheticFleetHandles();
  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'chaos-fleet-measure',
  });
  const fleet: ScaleFleet = createScaleFleet({
    handles,
    plan,
    timing: { leaseTtlMs: 5_000, heartbeatMs: 500, takeoverGraceMs: 1_000 },
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });

  const records: ChaosRunRecord[] = [];
  try {
    await fleet.start();
    // Backlog with REAL per-job wakes, so scenarios hit a fleet that is
    // sending (in-flight work at kill/flush/drain time) instead of an idle
    // one - `fleet.start()` seeds instances only (C1: sendsObserved was 0).
    const seeded = await resolveFleetInstances(pool, fleet);
    const enqueue = createMeasureEnqueue({ pool, redisCtl: handles.redisCtl, env: 'test' });
    for (const inst of seeded.instances) {
      for (let k = 0; k < args.jobsPerInstance; k += 1) {
        await enqueue({
          clientId: inst.clientId,
          instanceId: inst.instanceId,
          recipientJid: `${crypto.randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
          text: `chaos backlog ${String(k + 1)} ${crypto.randomUUID().slice(0, 8)}`,
          idempotencyKey: crypto.randomUUID(),
        });
      }
    }
    console.log(
      `run-chaos-fleet: enqueued ${String(args.jobsPerInstance)} jobs/instance (${String(seeded.instances.length * args.jobsPerInstance)} total) with wakes before the scenarios`,
    );
    const owners = await fleet.ownerMap();
    const fleetShape = {
      instances: owners.size,
      workers: plan.workers,
      sessionsPerWorker: plan.instancesPerWorker,
    };
    const ctx: ScenarioContext = {
      fleet,
      handles,
      pool,
      fleetShape,
      workerIds: Array.from({ length: plan.workers }, (_, i) => `scale-worker-${String(i)}`),
      clientIds: fleet.clientIds(),
      outcomeDeadlineMs: args.outcomeDeadlineMs,
      flushTarget: args.flushTarget,
    };

    for (const scenario of wanted) {
      console.log(`run-chaos-fleet: running scenario ${scenario}...`);
      const record = await runOneScenario(scenario, ctx);
      records.push(record);
      console.log(formatChaosRunMarkdown(record));
      console.log('');
    }

    let anyInvalid = false;
    for (const record of records) {
      const { ok, problems } = validateChaosRunRecord(record);
      if (!ok) {
        anyInvalid = true;
        console.error(`run-chaos-fleet: record for ${record.scenario} FAILED validation:`);
        for (const p of problems) console.error(`  - ${p}`);
      }
    }
    const anyFail = records.some((r) => r.verdict === 'FAIL');

    const artifact = {
      schemaVersion: 1 as const,
      kind: 'chaos-fleet-run' as const,
      capturedAtIso: new Date().toISOString(),
      hardware: readHardwareFingerprint(),
      node: process.version,
      fleet: {
        instances: owners.size,
        workers: plan.workers,
        sessionsPerWorker: plan.instancesPerWorker,
        tenants: plan.tenants,
      },
      records,
    };
    const outPath = resolve(process.cwd(), args.out);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`run-chaos-fleet: artifact written to ${args.out}`);

    if (anyInvalid || anyFail) {
      console.error(
        `run-chaos-fleet: ${anyInvalid ? 'an invalid record' : 'a FAIL verdict'} was produced`,
      );
      process.exitCode = 1;
    }
  } finally {
    // `fleet.stop()` drains every child then runs `cleanupScaleFleet`
    // internally - the ONLY cleanup needed for every row this run seeded.
    await fleet.stop();
    await disposeSyntheticFleetHandles(handles);
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err: unknown) => {
    console.error(describeError(err));
    process.exitCode = 1;
  });
}
