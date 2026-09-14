import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createArtifactWriter,
  MissingHardwareFingerprintError,
  SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER,
  type ArtifactHeader,
} from './artifact.js';

/**
 * artifact.test.ts (P10 Unit U3) - pure unit tests over the JSONL artifact
 * writer + header validation, with fake readers (no real ramp run).
 */

function baseHeader(overrides: Partial<ArtifactHeader> = {}): ArtifactHeader {
  return {
    schemaVersion: 1,
    capturedAtIso: '2026-09-01T00:00:00.000Z',
    profile: 'idle',
    rampPoints: [5, 10, 15, 20],
    plannedRampPoints: [5, 10, 15, 20],
    truncatedRampPoints: [],
    hardware: {
      cpuModel: 'AMD EPYC 7413',
      cpuCount: 12,
      totalMemBytes: 16_000_000_000,
      kernel: '5.15.0',
      cgroupVersion: 2,
    },
    node: 'v24.20.0',
    baileysVersion: '7.0.0-rc14',
    banner: SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER,
    isLinux: true,
    ...overrides,
  };
}

describe('createArtifactWriter header validation', () => {
  it('a_complete_header_writes_without_throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() => createArtifactWriter(outPath, baseHeader())).not.toThrow();
    expect(existsSync(outPath)).toBe(true);
  });

  it('a_header_missing_the_hardware_fingerprint_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() =>
      createArtifactWriter(outPath, baseHeader({ hardware: undefined as never })),
    ).toThrow(MissingHardwareFingerprintError);
  });

  it('a_non_linux_header_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() => createArtifactWriter(outPath, baseHeader({ isLinux: false }))).toThrow(
      MissingHardwareFingerprintError,
    );
  });

  it('a_header_missing_the_node_version_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() => createArtifactWriter(outPath, baseHeader({ node: '' }))).toThrow(
      MissingHardwareFingerprintError,
    );
  });

  it('a_header_missing_the_baileys_version_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() => createArtifactWriter(outPath, baseHeader({ baileysVersion: '' }))).toThrow(
      MissingHardwareFingerprintError,
    );
  });

  it('a_header_missing_the_banner_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() => createArtifactWriter(outPath, baseHeader({ banner: '' }))).toThrow(
      MissingHardwareFingerprintError,
    );
  });

  it('a_zero_or_empty_hardware_fingerprint_field_throws_a_named_error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    expect(() =>
      createArtifactWriter(
        outPath,
        baseHeader({ hardware: { ...baseHeader().hardware, cpuCount: 0 } }),
      ),
    ).toThrow(MissingHardwareFingerprintError);

    expect(() =>
      createArtifactWriter(
        outPath,
        baseHeader({ hardware: { ...baseHeader().hardware, cpuModel: '' } }),
      ),
    ).toThrow(MissingHardwareFingerprintError);
  });

  it('DOCUMENTED GAP: a truncatedRampPoints array that contradicts rampPoints/plannedRampPoints is NOT validated by the writer', () => {
    // The writer validates PRESENCE of hardware/node/baileysVersion/banner/
    // isLinux, but never cross-checks truncatedRampPoints against
    // rampPoints/plannedRampPoints for internal consistency. In production
    // this never happens because ramp-sessions.ts always computes
    // truncatedRampPoints itself (plannedRampPoints.filter(p =>
    // !rampPoints.includes(p))) - but a caller that hand-builds a header (or
    // a future bug in that computation) can write an internally
    // contradictory header without any error. This test pins the CURRENT
    // (permissive) behavior rather than asserting a validation rule that
    // does not exist - flagged in the C2 report as a probed gap, not
    // asserted as a bug fix here (would need a product decision on whether
    // the writer or only the ramp runner owns this invariant).
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    const contradictoryHeader = baseHeader({
      rampPoints: [5, 10, 15, 20],
      plannedRampPoints: [5, 10, 15, 20],
      // Claims a point was truncated that was never in plannedRampPoints at
      // all, AND is still present in rampPoints - internally impossible.
      truncatedRampPoints: [10, 999],
    });

    expect(() => createArtifactWriter(outPath, contradictoryHeader)).not.toThrow();
  });
});

describe('createArtifactWriter row emission', () => {
  it('writes_one_header_line_then_one_line_per_sample_and_summary_row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    const writer = createArtifactWriter(outPath, baseHeader());
    writer.writeSampleRow({
      ts: 1,
      sessions: 5,
      rssBytes: 1,
      cgroupCurrent: 1,
      heapUsed: 1,
      heapTotal: 1,
      external: 1,
      lagP50: 1,
      lagP99: 1,
      cpuPct: 1,
      batchAddMsP50: 1,
      batchAddMsP99: 1,
      redisSigBytes: 1,
      pgWriteRowsPerSec: 1,
    });
    writer.writeSummaryRow({
      sessions: 5,
      rssBytes: 1,
      lagP99: 1,
      cpuPct: 1,
      batchAddMs: 1,
      redisSigBytes: 1,
      pgWriteRowsPerSec: 1,
    });
    writer.finalizeArtifact();

    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const header = JSON.parse(lines[0] as string) as { kind: string };
    expect(header.kind).toBe('header');

    const sample = JSON.parse(lines[1] as string) as { kind: string };
    expect(sample.kind).toBe('sample');

    const summary = JSON.parse(lines[2] as string) as { kind: string };
    expect(summary.kind).toBe('summary');
  });

  it('finalizeArtifact_can_attach_a_fit_object_as_the_last_line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-artifact-'));
    const outPath = join(dir, 'artifact.jsonl');

    const writer = createArtifactWriter(outPath, baseHeader());
    writer.finalizeArtifact({ slopeMbPerSession: 20, interceptMb: 900, rSquared: 0.99 });

    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      kind: string;
      fit: { slopeMbPerSession: number };
    };
    expect(last.kind).toBe('fit');
    expect(last.fit.slopeMbPerSession).toBe(20);
  });
});
