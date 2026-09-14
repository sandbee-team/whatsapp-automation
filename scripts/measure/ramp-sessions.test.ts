import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRamp, DegradedRampPointError, type RampFleet } from './ramp-sessions.js';

/**
 * ramp-sessions.test.ts (P10 C2 probe) - PURE unit tests over `runRamp`'s
 * integrity guards, using a fully fake `RampFleet`/`pool`/`redisSig` (no
 * real PG/Redis/sockets - that live path is `ramp.integration.test.ts`).
 * Zero-ms settle/soak/sampleInterval windows keep this file fast and
 * deterministic without a fake clock (the module never reads `Date.now()`
 * for anything this file asserts on).
 */

function makeFakePool(): { query: () => Promise<{ rows: [] }> } {
  return { query: async () => ({ rows: [] }) };
}

function makeFakeRedisSig(): { info: () => Promise<string> } {
  return { info: async () => 'used_memory:1000\r\n' };
}

function baseHardware(): {
  cpuModel: string;
  cpuCount: number;
  totalMemBytes: number;
  kernel: string;
  cgroupVersion: number;
} {
  return {
    cpuModel: 'test-cpu',
    cpuCount: 4,
    totalMemBytes: 16_000_000_000,
    kernel: 'test-kernel',
    cgroupVersion: 2,
  };
}

/** A fleet whose `residentCount()` can be forced to disagree with `sessionCount()` at will. */
function makeFakeFleet(
  overrides: { residentDeltaAt?: (sessions: number) => number } = {},
): RampFleet & {
  sessionCountValue: number;
} {
  const state = { sessions: 0 };
  return {
    get sessionCountValue() {
      return state.sessions;
    },
    async addSessions(n: number): Promise<void> {
      state.sessions += n;
    },
    sessionCount(): number {
      return state.sessions;
    },
    residentCount(): number {
      const delta = overrides.residentDeltaAt?.(state.sessions) ?? 0;
      return state.sessions + delta;
    },
    forceGc(): void {
      // no-op
    },
  };
}

/**
 * A realistic RSS reader for the HEALTHY-path cases: a fixed baseline plus a
 * per-session slope, i.e. the shape a real ramp actually produces (the real
 * component-A run measured a 305 MB intercept + ~0.227 MB/session). This must
 * be injected rather than relying on the live `process.memoryUsage().rss`,
 * because with this file's 0 ms settle/soak windows the process RSS barely
 * moves between points - a FLAT series, which `fitRssRegression` now
 * (correctly) rejects with `DegenerateResponseError` since a flat response is
 * indistinguishable from a stuck/dead sampler. Reads `fleet.sessionCount()`
 * so the value tracks the ramp point actually in flight.
 */
function makeRealisticRssReader(
  fleet: RampFleet,
  baselineBytes = 300 * 1024 * 1024,
  perSessionBytes = 240 * 1024,
): () => number {
  return () => baselineBytes + fleet.sessionCount() * perSessionBytes;
}

function baseOptions(dir: string, fleet: RampFleet, fileName: string) {
  return {
    fleet,
    pool: makeFakePool(),
    redisSig: makeFakeRedisSig(),
    settleMs: 0,
    soakMs: 0,
    sampleIntervalMs: 0,
    artifactPath: join(dir, fileName),
    profile: 'idle',
    capturedAtIso: '2026-09-01T00:00:00.000Z',
    // isLinux must be true - createArtifactWriter rejects an off-Linux
    // header outright (see artifact.test.ts). The sampler's real /proc and
    // /sys/fs/cgroup readers are safely try/catch-wrapped to null off-Linux
    // (sampler.ts), so this stays safe on a non-Linux test host.
    isLinux: true,
    hardware: baseHardware(),
    node: 'v24.0.0',
    baileysVersion: '7.0.0-rc14',
  };
}

describe('runRamp integrity guards', () => {
  it('voids_a_point_where_residentCount_is_less_than_sessions_after_settle_never_publishing_it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    // Resident always 1 short of the target - degrades immediately after
    // settle, before any sample is taken.
    const fleet = makeFakeFleet({ residentDeltaAt: () => -1 });

    await expect(
      runRamp({ ...baseOptions(dir, fleet, 'a.jsonl'), rampPoints: [5, 10, 15, 20] }),
    ).rejects.toThrow(DegradedRampPointError);

    // Nothing beyond the header (and possibly nothing at all past it) was
    // ever written as a summary line for the degraded point.
    const lines = readFileSync(join(dir, 'a.jsonl'), 'utf8').trim().split('\n');
    const summaryLines = lines
      .map((l) => JSON.parse(l) as { kind: string })
      .filter((r) => r.kind === 'summary');
    expect(summaryLines).toHaveLength(0);
  });

  it('residentCount_greater_than_sessions_also_voids_the_point_impossible_but_asserted_anyway', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    const fleet = makeFakeFleet({ residentDeltaAt: () => 1 });

    await expect(
      runRamp({ ...baseOptions(dir, fleet, 'b.jsonl'), rampPoints: [5, 10, 15, 20] }),
    ).rejects.toThrow(DegradedRampPointError);
  });

  it('a_point_that_degrades_between_settle_and_post_soak_check_is_also_voided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    // Passes the settle-time check (delta 0 at first read) but the fleet
    // degrades by the time of the post-soak re-check. Since sessionCount is
    // read once per residentCount() call via a shared counter, simulate this
    // with a counter that starts healthy then flips.
    let checksSeen = 0;
    const fleet = makeFakeFleet({
      residentDeltaAt: () => {
        checksSeen += 1;
        // First residentCount() call (post-settle, for the FIRST ramp point)
        // is healthy; every call after that is degraded by 1.
        return checksSeen <= 1 ? 0 : -1;
      },
    });

    await expect(
      runRamp({ ...baseOptions(dir, fleet, 'c.jsonl'), rampPoints: [5, 10, 15, 20] }),
    ).rejects.toThrow(DegradedRampPointError);
  });

  it('three_accepted_points_after_one_voided_point_throws_rather_than_publishing_a_three_point_fit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    // The SECOND ramp point (10) degrades; points 1, 3, 4 would otherwise be
    // healthy. Since runRamp throws synchronously on the first degraded
    // point (never continuing to collect further points), the overall
    // promise must reject - a 3-point fit must never be silently published.
    const fleet = makeFakeFleet({
      residentDeltaAt: (sessions) => (sessions === 10 ? -1 : 0),
    });

    await expect(
      runRamp({ ...baseOptions(dir, fleet, 'd.jsonl'), rampPoints: [5, 10, 15, 20] }),
    ).rejects.toThrow(DegradedRampPointError);

    // Only point 1 (5 sessions) was ever accepted/published before the throw.
    const lines = readFileSync(join(dir, 'd.jsonl'), 'utf8').trim().split('\n');
    const summaryLines = lines
      .map((l) => JSON.parse(l) as { kind: string })
      .filter((r) => r.kind === 'summary');
    expect(summaryLines).toHaveLength(1);
  });

  it('a_healthy_four_point_ramp_publishes_a_fit_and_never_throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    const fleet = makeFakeFleet();

    const result = await runRamp({
      ...baseOptions(dir, fleet, 'e.jsonl'),
      rampPoints: [5, 10, 15, 20],
      readRssBytes: makeRealisticRssReader(fleet),
    });

    expect(result.summaries).toHaveLength(4);
    expect(result.fit).not.toBeNull();
    // The fit must recover the slope the fixture actually encodes
    // (240 KiB/session = 0.234375 MB/session), not merely be non-null - a
    // healthy ramp's whole point is that the regression reads the truth.
    expect(result.fit?.slopeMbPerSession).toBeCloseTo(240 / 1024, 3);
    expect(result.fit?.rSquared).toBeGreaterThan(0.99);
  });

  it('a_flat_rss_series_is_rejected_rather_than_published_as_a_perfect_fit', async () => {
    // A stuck/dead sampler returns the SAME rss at every ramp point. That is
    // not a "perfect fit" (R²=1) - it is a broken run, and `runRamp` must
    // surface it instead of publishing a 0-slope result with a zero-width CI.
    // Pins the DegenerateResponseError path (C1 suggestion 14) end-to-end at
    // the runner level, not just inside `fitRssRegression`.
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    const fleet = makeFakeFleet();

    await expect(
      runRamp({
        ...baseOptions(dir, fleet, 'g.jsonl'),
        rampPoints: [5, 10, 15, 20],
        readRssBytes: () => 400 * 1024 * 1024, // stuck reader - never moves
      }),
    ).rejects.toThrow(/flat response|DegenerateResponse/i);
  });

  it('truncatedRampPoints_records_exactly_the_planned_points_dropped_from_this_run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ramp-unit-'));
    const fleet = makeFakeFleet();

    await runRamp({
      ...baseOptions(dir, fleet, 'f.jsonl'),
      rampPoints: [5, 10, 15, 20],
      plannedRampPoints: [5, 10, 15, 20, 2500],
      readRssBytes: makeRealisticRssReader(fleet),
    });

    const lines = readFileSync(join(dir, 'f.jsonl'), 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0] as string) as { truncatedRampPoints: number[] };
    expect(header.truncatedRampPoints).toEqual([2500]);
  });
});
