import os from 'node:os';
import type { HardwareFingerprint } from '../../../../../scripts/measure/artifact.js';

/**
 * run-pacing-args.ts (P26 U5, step 5) - max-lines split off `run-pacing.ts`
 * (same idiom as `session-worker-discovery-wiring.ts`): CLI arg parsing and
 * the live hardware fingerprint reader, mirroring `run-drift.ts`'s own
 * `parseArgs`/`readHardwareFingerprint` shape (cgroupVersion is left `0`
 * here - this harness has no cgroup-memory measurement leg, unlike the
 * drift run).
 */

export interface RunPacingArgs {
  instances: number;
  workers: number;
  minutes: number;
  burstRecipients: number;
  burstAtSeconds: number;
  out: string;
  label: string;
}

export function parseRunPacingArgs(argv: string[]): RunPacingArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const val = argv[i + 1];
      map.set(arg.slice(2), val ?? 'true');
      if (val !== undefined) i += 1;
    }
  }
  const label = map.get('label') ?? '60m';
  const date = new Date().toISOString().slice(0, 10);
  return {
    instances: Number(map.get('instances') ?? 1000),
    workers: Number(map.get('workers') ?? 10),
    minutes: Number(map.get('minutes') ?? 60),
    burstRecipients: Number(map.get('burst-recipients') ?? 100_000),
    burstAtSeconds: Number(map.get('burst-at-seconds') ?? 1800),
    out: map.get('out') ?? `docs/measurements/${date}-pacing-${label}.json`,
    label,
  };
}

/** Live hardware fingerprint - `cgroupVersion` is always `0` (no cgroup-memory leg in this harness). */
export function readRunPacingHardware(): HardwareFingerprint {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    kernel: os.release(),
    cgroupVersion: 0,
  };
}
