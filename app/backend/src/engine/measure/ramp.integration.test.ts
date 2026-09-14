import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../session/synthetic-fleet-support.js';
import { cleanupProbeClients } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createMockWaPeer, type MockWaPeer } from './mock-wa-peer.js';
import { createMeasureFleet } from './measure-fleet.js';
import { runRamp } from '../../../../../scripts/measure/ramp-sessions.js';
import { IS_LINUX } from '../../../../../scripts/measure/sampler.js';

/**
 * ramp.integration.test.ts (P10 Unit U3, step 3) - proves the ramp
 * orchestrator against a TINY, sub-second-window ramp (5/10/15/20 sessions)
 * over the real mock-wa-peer + real measure fleet + real PG/Redis. Never
 * the phase's real 50/250/1000/2000 ramp with 5-min settle/20-min soak -
 * that is the U4 real run, outside this test.
 *
 * DEVIATION (this dispatch's actual execution host): the phase's target for
 * a *publishable* run is Linux cgroup v2 (`/sys/fs/cgroup/memory.current`,
 * `/proc/<pid>/stat`) - this test file's dev/CI sandbox may be Windows,
 * where those paths do not exist for the Node process regardless of the
 * `isLinux` flag passed to the header. This test therefore passes
 * `isLinux: true` (matching the real target's header contract, proven
 * separately and strictly in `scripts/measure/artifact.test.ts`), but
 * gates its own `cpuPct`/`cgroupCurrent` non-null assertions on `IS_LINUX`
 * (the REAL host) so it stays green on both a real Linux target and this
 * Windows sandbox without weakening the artifact-header rejection rule.
 */

let handles: SyntheticFleetHandles;
let peer: MockWaPeer;
let peerUrl: string;
let artifactDir: string;

beforeAll(async () => {
  handles = createSyntheticFleetHandles();
  peer = createMockWaPeer({ profile: 'idle' });
  peerUrl = await peer.start();
  artifactDir = mkdtempSync(join(tmpdir(), 'wp-ramp-artifact-'));
});

afterAll(async () => {
  await peer.close();
  await disposeSyntheticFleetHandles(handles);
});

let seededClientIds: string[] = [];

afterEach(async () => {
  if (seededClientIds.length > 0) {
    await cleanupProbeClients(handles.pool, seededClientIds);
    seededClientIds = [];
  }
});

describe('ramp-sessions orchestrator', () => {
  it('ramp_emits_one_summary_row_per_point_with_rss_lag_cpu_and_redis', async () => {
    const artifactPath = join(artifactDir, 'mini-ramp-1.jsonl');
    const fleet = createMeasureFleet(handles, {
      peerUrl,
      profile: 'idle',
      connectTimeoutMs: 30_000,
    });

    const result = await runRamp({
      fleet,
      pool: handles.pool,
      redisSig: handles.redisSig,
      rampPoints: [5, 10, 15, 20],
      settleMs: 20,
      soakMs: 100,
      sampleIntervalMs: 25,
      artifactPath,
      profile: 'idle',
      capturedAtIso: '2026-09-01T00:00:00.000Z',
      isLinux: true,
      hardware: {
        cpuModel: 'test-cpu',
        cpuCount: 4,
        totalMemBytes: 16_000_000_000,
        kernel: 'test-kernel',
        cgroupVersion: 2,
      },
      node: process.version,
      baileysVersion: '7.0.0-rc14',
    });

    seededClientIds = fleet.clientIds();
    await fleet.teardown();

    expect(result.summaries).toHaveLength(4);
    for (const summary of result.summaries) {
      expect(summary.rssBytes).toBeGreaterThan(0);
      expect(summary.lagP99).not.toBeNull();
      // cpuPct depends on /proc/<pid>/stat, which only exists on a real
      // Linux host - see the file-level DEVIATION doc comment.
      if (IS_LINUX) {
        expect(summary.cpuPct).not.toBeNull();
      }
      expect(summary.batchAddMs).not.toBeNull();
      expect(summary.redisSigBytes).not.toBeNull();
    }

    const lines = readFileSync(artifactPath, 'utf8').trim().split('\n');
    const summaryLines = lines
      .map((l) => JSON.parse(l) as { kind: string })
      .filter((r) => r.kind === 'summary');
    expect(summaryLines).toHaveLength(4);
  }, 30_000);

  it('mini_ramp_produces_a_fit_with_r_squared_above_zero_nine', async () => {
    const artifactPath = join(artifactDir, 'mini-ramp-2.jsonl');
    const fleet = createMeasureFleet(handles, {
      peerUrl,
      profile: 'idle',
      connectTimeoutMs: 30_000,
    });

    const result = await runRamp({
      fleet,
      pool: handles.pool,
      redisSig: handles.redisSig,
      rampPoints: [5, 10, 15, 20],
      settleMs: 20,
      soakMs: 100,
      sampleIntervalMs: 25,
      artifactPath,
      profile: 'idle',
      capturedAtIso: '2026-09-01T00:00:00.000Z',
      isLinux: true,
      hardware: {
        cpuModel: 'test-cpu',
        cpuCount: 4,
        totalMemBytes: 16_000_000_000,
        kernel: 'test-kernel',
        cgroupVersion: 2,
      },
      node: process.version,
      baileysVersion: '7.0.0-rc14',
      // Deterministic RSS reader. This case guards the RUNNER's fit plumbing,
      // NOT the capacity number (see the case name's own intent), so it must
      // not depend on live `process.memoryUsage().rss`: under full-suite load
      // other suites' allocations perturb this process's RSS, which makes the
      // RSS-vs-sessions relationship noisy (R² can fall below 0.9) or even
      // flat (now a `DegenerateResponseError` after C1 suggestion 14) - i.e.
      // an unrelated suite could turn this red. The real capacity measurement
      // uses the live reader by default (`run-component-a.ts`); a fixed
      // baseline + per-session slope here keeps the assertion about the
      // regression's wiring, deterministically.
      readRssBytes: () => 300 * 1024 * 1024 + fleet.sessionCount() * 240 * 1024,
    });

    seededClientIds = fleet.clientIds();
    await fleet.teardown();

    expect(result.fit).not.toBeNull();
    expect(result.fit?.rSquared).toBeGreaterThan(0.9);
    // Deterministic fixture ⇒ the fit must recover the encoded slope exactly
    // (240 KiB/session), which a noise-driven fit never could.
    expect(result.fit?.slopeMbPerSession).toBeCloseTo(240 / 1024, 3);

    const lines = readFileSync(artifactPath, 'utf8').trim().split('\n');
    const fitLine = lines
      .map((l) => JSON.parse(l) as { kind: string })
      .find((r) => r.kind === 'fit');
    expect(fitLine).toBeDefined();
  }, 30_000);

  it('artifact_header_records_hardware_node_and_pinned_baileys_version', async () => {
    const artifactPath = join(artifactDir, 'mini-ramp-3.jsonl');
    const fleet = createMeasureFleet(handles, {
      peerUrl,
      profile: 'idle',
      connectTimeoutMs: 30_000,
    });

    const result = await runRamp({
      fleet,
      pool: handles.pool,
      redisSig: handles.redisSig,
      rampPoints: [5, 10, 15, 20],
      settleMs: 20,
      soakMs: 100,
      sampleIntervalMs: 25,
      artifactPath,
      profile: 'idle',
      capturedAtIso: '2026-09-01T00:00:00.000Z',
      isLinux: true,
      hardware: {
        cpuModel: 'test-cpu',
        cpuCount: 4,
        totalMemBytes: 16_000_000_000,
        kernel: 'test-kernel',
        cgroupVersion: 2,
      },
      node: process.version,
      baileysVersion: '7.0.0-rc14',
    });

    seededClientIds = fleet.clientIds();
    await fleet.teardown();
    void result;

    const lines = readFileSync(artifactPath, 'utf8').trim().split('\n');
    const header = JSON.parse(lines[0] as string) as {
      kind: string;
      hardware: unknown;
      node: string;
      baileysVersion: string;
    };
    expect(header.kind).toBe('header');
    expect(header.hardware).toBeTruthy();
    expect(header.node).toBe(process.version);
    expect(header.baileysVersion).toBe('7.0.0-rc14');

    // A header missing the hardware fingerprint (or Node/Baileys version)
    // must be rejected by the writer - proven directly against the artifact
    // writer in scripts/measure/artifact.test.ts; this integration test
    // proves the complete-header path writes for real.
  }, 30_000);
});
