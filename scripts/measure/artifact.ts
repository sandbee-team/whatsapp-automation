import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SampleRow } from './sampler.js';

/**
 * scripts/measure/artifact.ts (P10 Unit U3, step 3) - the JSONL artifact
 * writer + hardware-fingerprint header, per ADR 0032 + P10 step 4.
 *
 * A table without a hardware fingerprint (or missing Node/Baileys version,
 * or captured off-Linux) is not a measurement (ADR 0032; phase risk
 * "Windows figures are not publishable") - `createArtifactWriter` REJECTS
 * such a header at construction time via `MissingHardwareFingerprintError`,
 * before a single byte is written.
 */

/** The exact ADR 0032 banner string, imported/duplicated here as a named const (never re-typed at call sites). */
export const SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER =
  'SOCKET-RESIDENT-PRE-HANDSHAKE (component A): real Baileys sockets constructed through the real EncryptedAuthStore and bounded Signal key store, holding a live TLS/WS connection and the full socket object graph resident at the awaited-serverHello point of the real Noise XX handshake. The handshake does not and cannot complete against a local peer (no cert forgery - invariant 6). This measures section 1.1 rows 1,2,3,7,11,12. It does NOT measure the post-handshake transport (row-1 keepalive cadence, the noise transport cipher state), the initial app-state/query traffic, or any real Signal/group working set (rows 4,5,6,9 - component B, P10a). Not a per-session cost; the per-session number is A + B. No figure here may be quoted to a customer (ADR 0016, ADR 0018 section 8).';

export class MissingHardwareFingerprintError extends Error {
  constructor(reason: string) {
    super(
      `createArtifactWriter: refusing to write an artifact without a valid hardware fingerprint - ${reason}. A table without a hardware fingerprint is not a measurement (ADR 0032).`,
    );
    this.name = 'MissingHardwareFingerprintError';
  }
}

export interface HardwareFingerprint {
  cpuModel: string;
  cpuCount: number;
  totalMemBytes: number;
  kernel: string;
  cgroupVersion: number;
}

export interface ArtifactHeader {
  schemaVersion: number;
  /** Injected - never `Date.now()`/`new Date()` called inside this module. */
  capturedAtIso: string;
  profile: string;
  rampPoints: number[];
  plannedRampPoints: number[];
  /**
   * Planned ramp points that were dropped from this run (e.g. the 2,500
   * point truncated per ADR 0032's ramp-design note) - recorded, never
   * fabricated.
   */
  truncatedRampPoints: number[];
  hardware: HardwareFingerprint;
  node: string;
  baileysVersion: string;
  banner: string;
  isLinux: boolean;
}

export interface SummaryRow {
  sessions: number;
  /** Trimmed mean over the soak window. */
  rssBytes: number;
  lagP99: number;
  cpuPct: number | null;
  /**
   * WARNING 5 (FIX-P10-A): renamed from `connectMsP99` - this is the
   * cumulative wall-clock duration of this ramp point's whole sequential
   * `addSessions(delta)` batch-build loop (~20 ms/socket at this repo's
   * measured rate), NOT a per-socket connect latency. No per-socket
   * connect/handshake latency was measured this session (carried to
   * P26/M5). The raw JSONL artifact's `connectMsP50`/`connectMsP99` fields
   * are historical evidence and are NOT renamed/rewritten - they carry this
   * same batch-add semantics under their original field names.
   */
  batchAddMs: number | null;
  redisSigBytes: number | null;
  pgWriteRowsPerSec: number | null;
}

export interface RssFit {
  slopeMbPerSession: number;
  interceptMb: number;
  rSquared: number;
}

export interface ArtifactWriter {
  writeSampleRow(row: SampleRow): void;
  writeSummaryRow(row: SummaryRow): void;
  /** Writes the final `fit` line (if a fit is supplied) and closes out the artifact. */
  finalizeArtifact(fit?: RssFit): void;
  readonly path: string;
}

function assertValidHeader(header: ArtifactHeader): void {
  if (!header.isLinux) {
    throw new MissingHardwareFingerprintError(
      'captured off-Linux (memory.current and /proc/<pid>/stat do not exist there)',
    );
  }
  if (!header.hardware) {
    throw new MissingHardwareFingerprintError('hardware fingerprint object is missing');
  }
  const { cpuModel, cpuCount, totalMemBytes, kernel, cgroupVersion } = header.hardware;
  if (!cpuModel || !cpuCount || !totalMemBytes || !kernel || !cgroupVersion) {
    throw new MissingHardwareFingerprintError('hardware fingerprint has an empty/zero field');
  }
  if (!header.node) {
    throw new MissingHardwareFingerprintError('node version is missing');
  }
  if (!header.baileysVersion) {
    throw new MissingHardwareFingerprintError('baileysVersion is missing');
  }
  if (!header.banner) {
    throw new MissingHardwareFingerprintError('banner is missing');
  }
}

/**
 * Builds a JSONL artifact writer at `path` (parent directory created if
 * needed) and immediately writes the validated header as line 1. Throws
 * `MissingHardwareFingerprintError` (before any write) if the header is
 * incomplete.
 */
export function createArtifactWriter(path: string, header: ArtifactHeader): ArtifactWriter {
  assertValidHeader(header);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ kind: 'header', ...header })}\n`, 'utf8');

  return {
    path,
    writeSampleRow(row: SampleRow): void {
      appendFileSync(path, `${JSON.stringify({ kind: 'sample', ...row })}\n`, 'utf8');
    },
    writeSummaryRow(row: SummaryRow): void {
      appendFileSync(path, `${JSON.stringify({ kind: 'summary', ...row })}\n`, 'utf8');
    },
    finalizeArtifact(fit?: RssFit): void {
      if (fit) {
        appendFileSync(path, `${JSON.stringify({ kind: 'fit', fit })}\n`, 'utf8');
      }
    },
  };
}
