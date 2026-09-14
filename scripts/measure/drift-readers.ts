import { readFileSync } from 'node:fs';

/**
 * scripts/measure/drift-readers.ts (P26 Unit U3, step 3) - Linux-only
 * readers for the drift run's GC-pause and container network-counter
 * fields, split out of `drift-run.ts` to stay under the 300-line cap.
 *
 * Both readers are pure functions over already-collected/already-read data
 * (never call `Date.now()` or hold their own timers) - `run-drift.ts` owns
 * the `PerformanceObserver` subscription and the per-tick GC-duration buffer
 * reset; this module only reduces a buffer / parses a proc file.
 */

export interface GcStats {
  pauseP99Ms: number | null;
  count: number | null;
}

/**
 * Reduces one tick's worth of already-collected GC entry durations (ms) into
 * a p99 + count. Returns nulls for an empty buffer (never a fabricated 0).
 */
export function readGcStatsReal(durationsMs: readonly number[]): GcStats {
  if (durationsMs.length === 0) {
    return { pauseP99Ms: null, count: null };
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1);
  return { pauseP99Ms: sorted[Math.max(0, idx)] as number, count: sorted.length };
}

export interface NetDevBytes {
  rx: number | null;
  tx: number | null;
}

/**
 * Sums rx/tx byte totals over every non-`lo` interface in `/proc/net/dev`.
 * Returns nulls off-Linux or on any read/parse failure (never throws - a
 * missing counter must not tear down a 7-day run).
 */
export function readNetDevBytesReal(): NetDevBytes {
  let raw: string;
  try {
    raw = readFileSync('/proc/net/dev', 'utf8');
  } catch {
    return { rx: null, tx: null };
  }

  let rx = 0;
  let tx = 0;
  let sawAny = false;

  // Format: two header lines, then `iface: rxBytes rxPackets ... txBytes ...`
  // (rx has 8 fields, tx starts at field 9; field 0 is rxBytes, field 8 is
  // txBytes after splitting the iface name off on ':').
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const iface = line.slice(0, colonIdx).trim();
    if (iface === '' || iface === 'lo') continue;

    const fields = line
      .slice(colonIdx + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 9) continue;

    rx += fields[0] as number;
    tx += fields[8] as number;
    sawAny = true;
  }

  return sawAny ? { rx, tx } : { rx: null, tx: null };
}
