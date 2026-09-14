import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MissingHardwareFingerprintError } from './artifact.js';
import type { DriftRunHeader, DriftArtifactRow, DriftArtifactRowWriter } from './drift-run.js';

/**
 * scripts/measure/drift-run-writer.ts (P26 Unit U3, step 3) - the drift
 * artifact writer, split out of `drift-run.ts` to stay under the 300-line
 * cap (the established split idiom - see `session-worker-discovery-wiring.ts`).
 *
 * Performs the SAME fingerprint validation as `artifact.ts`'s
 * `assertValidHeader` (non-Linux / empty fingerprint field / missing
 * node/baileysVersion/banner => throws `MissingHardwareFingerprintError`) but
 * over the DRIFT header shape, which is not the ramp `ArtifactHeader` shape
 * (drift rows are hourly samples over a fixed N, not ramp-point summaries).
 */

function assertValidDriftHeader(header: DriftRunHeader): void {
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

export interface DriftArtifactWriter extends DriftArtifactRowWriter {
  readonly path: string;
}

/**
 * Builds a drift artifact writer at `path` (parent directory created if
 * needed) and immediately writes the validated header as line 1. Throws
 * `MissingHardwareFingerprintError` (before any write) if the header is
 * incomplete. When `headerCopyPath` is given, also writes a pretty-printed
 * JSON copy of the header there (the published `docs/measurements/<date>-
 * drift-header.json` convention).
 */
export function createDriftArtifactWriter(
  path: string,
  header: DriftRunHeader,
  headerCopyPath?: string,
): DriftArtifactWriter {
  assertValidDriftHeader(header);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(header)}\n`, 'utf8');

  if (headerCopyPath) {
    mkdirSync(dirname(headerCopyPath), { recursive: true });
    writeFileSync(headerCopyPath, `${JSON.stringify(header, null, 2)}\n`, 'utf8');
  }

  return {
    path,
    writeRow(row: DriftArtifactRow): void {
      appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
    },
  };
}
