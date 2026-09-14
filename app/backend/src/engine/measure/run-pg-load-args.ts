import os from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ABSOLUTE_GAP_MIN_MS, ABSOLUTE_DAILY_CEILING } from '@wp/domain';
import { SCALE_FLEET_SAFETY_POLL_MS } from '../../../../../scripts/measure/scale-fleet.js';
import type { HardwareFingerprint } from '../../../../../scripts/measure/artifact.js';
import {
  expandTenantMix,
  parseTenantMix,
  weightedMeanSendsPerDayPerInstance,
  type ExpandedTenant,
} from '../../../../../scripts/loadtest/tenant-mix.js';

/**
 * run-pg-load-args.ts (P26 U4c) - the CLI surface and the DRAIN ARITHMETIC
 * for `run-pg-load.ts`, split off for the 300-line cap (established idiom:
 * `session-worker-discovery-wiring.ts`).
 *
 * WHY THE ARITHMETIC LIVES HERE AND IS ENFORCED BEFORE ANY SEEDING: the
 * first real run of this harness was sized as if enqueue rate set the pace.
 * It does not. `runSendLoad` enqueues at one job per instance per second,
 * but the DRAIN is bounded by the real pacing gate
 * (`db/queries/reserve-pacing.sql`): each instance may grant at most one
 * send every `eff_gap_min_ms`, floored platform-wide at
 * `ABSOLUTE_GAP_MIN_MS` (15s, `packages/domain/src/pacing/constants.ts`).
 * So the drain floor is
 *   `ceil(sends / instances) * ABSOLUTE_GAP_MIN_MS`,
 * independent of how fast rows are inserted. 100k sends over 50 instances
 * is 2,000 sends/instance = 8.3 HOURS; the same 100k over 1,000 instances
 * is 100 sends/instance = 25 minutes - which is also the honest shape of
 * the measurement (the load model at N connected numbers).
 *
 * AND THE CAPS MUST FIT THE SAME NUMBER: `reserve-pacing.sql` independently
 * enforces `sent_this_hour < eff_hourly_cap` and
 * `consumed_count < eff_daily_cap`. `scale-fleet-seed.ts` defaults those to
 * 60/600, so 100 sends per instance inside ~25 minutes would stall on the
 * hourly cap at 60 and defer the remainder to the next clock hour - the
 * drain would appear to hang. `resolveSeededCaps` therefore sizes both caps
 * off `sends/instances` and `assertDrainFeasible` REFUSES the run (named
 * error, before a single row is seeded) when they do not fit, naming the
 * flag to change. Both seeded caps are recorded in the artifact `notes`:
 * they are a MEASUREMENT CONDITION, never a tenant setting.
 */

export interface CliArgs {
  sends: number;
  instances: number;
  tenants: number;
  workers: number;
  forcePgBouncer: boolean;
  out: string;
  projectedAt: number[];
  drainTimeoutMinutes: number;
  hourlyCap: number;
  dailyCap: number;
  /** True when `--drain-timeout-minutes` was absent and the value above was derived from the drain arithmetic. */
  drainTimeoutDerived: boolean;
  /** MAJOR 4: explicit override for the projection's sends/day/instance input. `undefined` means "derive the weighted mean from `scripts/loadtest/tenant-mix.json`" - never a bare literal (see `run-pg-load.ts`'s own header). */
  sendsPerDay: number | undefined;
  /** MAJOR 5: seconds of IDLE baseline sampled after `fleet.start()` and before the drive, to subtract database-global deltas caused by anything else sharing this Postgres. `0` means "explicitly skipped" and must be named in a note. */
  baselineSeconds: number;
  /** MAJOR 5: names whatever else is running on this box during the measurement (e.g. the drift fleet) - defaults to "none declared" so an unlabeled run is visibly honest, never silently assumed idle. */
  concurrentNote: string;
}

/** `ceil(sends/instances)` - the number of sends ONE instance must drain, which is what both the gap floor and both caps are measured against. */
export function sendsPerInstance(sends: number, instances: number): number {
  return Math.ceil(sends / Math.max(1, instances));
}

/** The gap-floor-bounded drain time in seconds: `ceil(sends/instances) * ABSOLUTE_GAP_MIN_MS/1000`. Never derived from the enqueue rate (see module header). */
export function expectedDrainSeconds(sends: number, instances: number): number {
  // One claim per trigger + edge-triggered wakes + no `next_eligible_at`
  // nudge (P26 run log #17) => a paced backlog drains one job per instance
  // per max(pacing gap, safety poll), not per gap.
  const perSendMs = Math.max(ABSOLUTE_GAP_MIN_MS, SCALE_FLEET_SAFETY_POLL_MS);
  return sendsPerInstance(sends, instances) * (perSendMs / 1000);
}

/** Default `--drain-timeout-minutes`: twice the expected drain (whole minutes) plus 5 minutes of fleet stand-up/tear-down headroom. */
export function defaultDrainTimeoutMinutes(sends: number, instances: number): number {
  return Math.ceil(expectedDrainSeconds(sends, instances) / 60) * 2 + 5;
}

/** Thrown BEFORE any seeding when the requested shape cannot drain under the caps that would be seeded - names the flag to change rather than silently truncating the measurement. */
export class InfeasibleDrainError extends Error {
  override readonly name = 'InfeasibleDrainError';
}

/**
 * Refuses a run whose `sends/instances` cannot fit under the seeded caps, or
 * whose caps violate the DB CHECK ceilings
 * (`instance_pacing_state_eff_daily_cap_ceiling`, `ABSOLUTE_DAILY_CEILING`)
 * or the hourly<=daily ordering the reserve statement assumes.
 */
export function assertDrainFeasible(args: CliArgs): void {
  const perInstance = sendsPerInstance(args.sends, args.instances);
  if (args.dailyCap > ABSOLUTE_DAILY_CEILING) {
    throw new InfeasibleDrainError(
      `--daily-cap ${String(args.dailyCap)} exceeds ABSOLUTE_DAILY_CEILING (${String(ABSOLUTE_DAILY_CEILING)}), which the instance_pacing_state CHECK rejects - lower --daily-cap`,
    );
  }
  if (args.hourlyCap > args.dailyCap) {
    throw new InfeasibleDrainError(
      `--hourly-cap ${String(args.hourlyCap)} exceeds --daily-cap ${String(args.dailyCap)} - the daily cap binds first, so raise --daily-cap or lower --hourly-cap`,
    );
  }
  if (perInstance > args.hourlyCap) {
    throw new InfeasibleDrainError(
      `${String(args.sends)} sends over ${String(args.instances)} instances is ${String(perInstance)} sends/instance, above the seeded eff_hourly_cap ${String(args.hourlyCap)} - the drain would stall until the next clock hour; raise --hourly-cap (<= --daily-cap <= ${String(ABSOLUTE_DAILY_CEILING)}) or raise --instances`,
    );
  }
  if (perInstance > args.dailyCap) {
    throw new InfeasibleDrainError(
      `${String(args.sends)} sends over ${String(args.instances)} instances is ${String(perInstance)} sends/instance, above the seeded eff_daily_cap ${String(args.dailyCap)} - raise --daily-cap (<= ${String(ABSOLUTE_DAILY_CEILING)}) or raise --instances`,
    );
  }
}

function numberFlag(map: Map<string, string>, key: string, fallback: number): number {
  const raw = map.get(key);
  return raw === undefined ? fallback : Number(raw);
}

export function parseRunPgLoadArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  let forcePgBouncer = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--via-pgbouncer') {
      forcePgBouncer = true;
      continue;
    }
    if (arg !== undefined && arg.startsWith('--')) {
      const val = argv[i + 1];
      if (val !== undefined) {
        map.set(arg.slice(2), val);
        i += 1;
      }
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const sends = numberFlag(map, 'sends', 100_000);
  const instances = numberFlag(map, 'instances', 1_000);
  const perInstance = sendsPerInstance(sends, instances);
  const drainTimeoutRaw = map.get('drain-timeout-minutes');
  return {
    sends,
    instances,
    tenants: numberFlag(map, 'tenants', 10),
    workers: numberFlag(map, 'workers', 10),
    forcePgBouncer,
    out: map.get('out') ?? `docs/measurements/${date}-loadmodel.json`,
    projectedAt: (map.get('projected-at') ?? '1000,2000,10000').split(',').map(Number),
    drainTimeoutMinutes:
      drainTimeoutRaw === undefined
        ? defaultDrainTimeoutMinutes(sends, instances)
        : Number(drainTimeoutRaw),
    drainTimeoutDerived: drainTimeoutRaw === undefined,
    hourlyCap: numberFlag(map, 'hourly-cap', Math.max(200, perInstance + 10)),
    dailyCap: numberFlag(map, 'daily-cap', Math.max(600, perInstance + 10)),
    sendsPerDay: map.has('sends-per-day') ? Number(map.get('sends-per-day')) : undefined,
    baselineSeconds: numberFlag(map, 'baseline-seconds', 60),
    concurrentNote: map.get('concurrent-note') ?? 'none declared',
  };
}

export function readHardwareFingerprint(): HardwareFingerprint {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    kernel: os.release(),
    cgroupVersion: process.platform === 'linux' ? 2 : 0,
  };
}

/**
 * MAJOR 4: resolves the projection's sends/day/instance INPUT - `--sends-
 * per-day` if the operator passed one, else the tenant mix's own weighted
 * mean at `instances` scale (`scripts/loadtest/tenant-mix.json`, the same
 * file `run-pacing.ts` already treats as the one source of tenant-behaviour
 * inputs). Never a bare literal: this is the ONE call site that converts
 * "the mix" into a number, and the caller records which source won in the
 * artifact's own notes.
 */
export function resolveProjectedSendsPerDay(args: {
  sendsPerDay: number | undefined;
  instances: number;
}): { value: number; source: string } {
  if (args.sendsPerDay !== undefined) {
    return { value: args.sendsPerDay, source: '--sends-per-day (operator override)' };
  }
  const mixPath = resolve(process.cwd(), 'scripts/loadtest/tenant-mix.json');
  const mix = parseTenantMix(JSON.parse(readFileSync(mixPath, 'utf8')));
  const expanded = expandTenantMix(mix, args.instances);
  const value = weightedMeanSendsPerDayPerInstance(expanded.tenants as ExpandedTenant[]);
  return {
    value,
    source: 'scripts/loadtest/tenant-mix.json (weighted mean over the expanded mix)',
  };
}
