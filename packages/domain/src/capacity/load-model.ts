/**
 * Measured per-send load ratios and daily-growth projection (P26 Unit U1,
 * step 1; ADR 0018 section 7). Replaces the fixed "12 statements/send, 3.2 KB
 * bytes/send, 600 sends/day/instance" constants that earlier capacity math
 * reached for - every number here is a ratio DERIVED from a measured window
 * of `{sendCount, statementDelta, relationSizeDeltaBytes, walBytes,
 * windowSeconds}`, never a hardcoded constant. There is intentionally no
 * literal `12`, `3.2`, or `600` anywhere in this module.
 *
 * A ratio without its sample size cannot be published: every `LoadModel` and
 * `DailyGrowthProjection` carries a `sampleSize` (the `sendCount` and
 * `windowSeconds` the ratio was measured over), which is why `sendCount <= 0`
 * throws `UnpublishableLoadModelError` instead of returning `NaN`/`Infinity`
 * from a division by zero - a rate with no denominator is not a
 * measurement.
 *
 * Pure and deterministic: no I/O, no Date.now(), no RNG, no Node builtins.
 */

export class UnpublishableLoadModelError extends Error {
  readonly sendCount: number;

  constructor(sendCount: number) {
    super(`loadModel: sendCount must be a finite number > 0 to publish a ratio, got ${sendCount}`);
    this.name = 'UnpublishableLoadModelError';
    this.sendCount = sendCount;
  }
}

export class InvalidLoadModelWindowError extends Error {
  readonly windowSeconds: number;

  constructor(windowSeconds: number) {
    super(`loadModel: windowSeconds must be a finite number > 0, got ${windowSeconds}`);
    this.name = 'InvalidLoadModelWindowError';
    this.windowSeconds = windowSeconds;
  }
}

/**
 * BUG FIX (P26 C2): `statementDelta`/`relationSizeDeltaBytes`/`walBytes` were
 * unvalidated - a NaN/Infinity delta (a plausible `pg_stat_statements`/
 * `pg_total_relation_size` read glitch) silently propagated into
 * `statementsPerSend`/`bytesPerSend`/`walMbPerSec`, i.e. exactly the
 * "returning NaN/Infinity from a division by zero" outcome this module's own
 * header says `sendCount`'s validation exists to prevent - just applied to
 * the wrong operand. A non-finite measured delta is never a valid
 * measurement (a negative delta legitimately means net shrink and is left
 * alone - see `pg-load-validate.ts`'s own `relationSizeBytes < 0` handling).
 */
export class InvalidLoadModelDeltaError extends Error {
  readonly field: string;
  readonly value: number;

  constructor(field: string, value: number) {
    super(`loadModel: ${field} must be a finite number, got ${value}`);
    this.name = 'InvalidLoadModelDeltaError';
    this.field = field;
    this.value = value;
  }
}

export class InvalidConnectedCountError extends Error {
  readonly connected: number;

  constructor(connected: number) {
    super(`projectDailyGrowth: connected must be a finite number >= 0, got ${connected}`);
    this.name = 'InvalidConnectedCountError';
    this.connected = connected;
  }
}

export interface LoadModelInput {
  readonly sendCount: number;
  readonly statementDelta: number;
  readonly relationSizeDeltaBytes: number;
  readonly walBytes: number;
  readonly windowSeconds: number;
}

export interface LoadModelSampleSize {
  readonly sendCount: number;
  readonly windowSeconds: number;
}

export interface LoadModel {
  readonly statementsPerSend: number;
  readonly bytesPerSend: number;
  readonly walMbPerSec: number;
  readonly sendsPerSecond: number;
  readonly sampleSize: LoadModelSampleSize;
}

export interface DailyGrowthProjection {
  readonly bytesPerDay: number;
  readonly gbPerDay: number;
  readonly connected: number;
  readonly sendsPerDayPerInstance: number;
  readonly sampleSize: LoadModelSampleSize;
}

const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

export function loadModel(input: LoadModelInput): LoadModel {
  const { sendCount, statementDelta, relationSizeDeltaBytes, walBytes, windowSeconds } = input;

  if (!Number.isFinite(sendCount) || sendCount <= 0) {
    throw new UnpublishableLoadModelError(sendCount);
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new InvalidLoadModelWindowError(windowSeconds);
  }
  if (!Number.isFinite(statementDelta)) {
    throw new InvalidLoadModelDeltaError('statementDelta', statementDelta);
  }
  if (!Number.isFinite(relationSizeDeltaBytes)) {
    throw new InvalidLoadModelDeltaError('relationSizeDeltaBytes', relationSizeDeltaBytes);
  }
  if (!Number.isFinite(walBytes)) {
    throw new InvalidLoadModelDeltaError('walBytes', walBytes);
  }

  return {
    statementsPerSend: statementDelta / sendCount,
    bytesPerSend: relationSizeDeltaBytes / sendCount,
    walMbPerSec: walBytes / BYTES_PER_MIB / windowSeconds,
    sendsPerSecond: sendCount / windowSeconds,
    sampleSize: { sendCount, windowSeconds },
  };
}

export function projectDailyGrowth(
  model: LoadModel,
  input: { readonly connected: number; readonly sendsPerDayPerInstance: number },
): DailyGrowthProjection {
  const { connected, sendsPerDayPerInstance } = input;

  if (!Number.isFinite(connected) || connected < 0) {
    throw new InvalidConnectedCountError(connected);
  }

  const bytesPerDay = model.bytesPerSend * sendsPerDayPerInstance * connected;

  return {
    bytesPerDay,
    gbPerDay: bytesPerDay / BYTES_PER_GIB,
    connected,
    sendsPerDayPerInstance,
    sampleSize: model.sampleSize,
  };
}
