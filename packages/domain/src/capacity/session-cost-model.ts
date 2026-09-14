/**
 * Composed per-session capacity model (P10 Unit U1, ADR 0018 §2 / scope
 * delta canon).
 *
 * `perSessionMb = A(sockets) + B(contacts, groups)`:
 *   - A is the measured RSS regression slope from `rss-regression.ts`
 *     (socket/runtime marginal cost per session).
 *   - B is Signal protocol state: `contacts * signalMbPerContact` for
 *     direct-message identity/session records, plus group state.
 *
 * Group state is `trackedDevices * recordKb / 1024` - NEVER a flat 1 MB.
 * A single 184-participant group is 200-400 Signal sender-key records
 * (roughly one per participant device), not a rounding error; modelling it
 * as a flat constant is the exact error this module exists to kill.
 *
 * ADR 0018 §2: the per-session figure is a bracket, never a single number,
 * and a groups-enabled instance can never be quoted the dm-only figure.
 * `composeSessionMb` enforces this structurally: `groupEnabled` is always
 * `dmOnly + groupStateMb(...)` with tracked devices floored at 1 whenever
 * the group profile is requested, so `groupEnabled > dmOnly` holds for
 * every input, including `groupDevices: 0` (an instance with groups enabled
 * but no tracked devices yet still carries the group-membership overhead of
 * at least one tracked device's worth of state).
 *
 * Pure and deterministic: no I/O, no Date, no RNG, no Node builtins.
 */

export class InvalidRecordSizeError extends Error {
  constructor(recordKb: number) {
    super(`groupStateMb: recordKb must be > 0, got ${recordKb}`);
    this.name = 'InvalidRecordSizeError';
  }
}

export class InvalidTrackedDevicesError extends Error {
  constructor(trackedDevices: number) {
    super(`groupStateMb: trackedDevices must be >= 0, got ${trackedDevices}`);
    this.name = 'InvalidTrackedDevicesError';
  }
}

const BYTES_PER_MB_IN_KB = 1024;

/** Minimum tracked devices assumed for a groups-enabled instance's group
 * state, even if the caller reports 0 currently-tracked devices - see the
 * module doc comment on why `groupEnabled` must never collapse to `dmOnly`.
 */
const MIN_GROUP_ENABLED_TRACKED_DEVICES = 1;

export interface GroupStateInput {
  /** Count of tracked group-participant devices (one participant may map
   * to multiple devices). */
  readonly trackedDevices: number;
  /** Measured Signal sender-key record size, in kilobytes. */
  readonly recordKb: number;
}

/**
 * `trackedDevices * recordKb / 1024` - linear in device count, never a flat
 * constant. Rejects a non-positive record size and a negative device count.
 */
export function groupStateMb({ trackedDevices, recordKb }: GroupStateInput): number {
  if (!(recordKb > 0)) {
    throw new InvalidRecordSizeError(recordKb);
  }
  if (trackedDevices < 0) {
    throw new InvalidTrackedDevicesError(trackedDevices);
  }
  return (trackedDevices * recordKb) / BYTES_PER_MB_IN_KB;
}

export interface ComposeSessionMbInput {
  /** Measured RSS regression slope A(sockets): MB per session from socket
   * / runtime overhead alone. */
  readonly socketSlopeMb: number;
  /** Signal DM state cost per contact, in MB. */
  readonly signalMbPerContact: number;
  readonly contacts: number;
  /** Tracked group-participant devices for this instance. */
  readonly groupDevices: number;
  readonly recordKb: number;
}

export interface SessionMbProfile {
  /** Per-session MB with direct messages only - no group state. */
  readonly dmOnly: number;
  /** Per-session MB with groups enabled - always > dmOnly. */
  readonly groupEnabled: number;
}

/**
 * Composes the per-session MB profile: `dmOnly` (sockets + DM Signal state)
 * and `groupEnabled` (`dmOnly` plus group state, devices floored at
 * `MIN_GROUP_ENABLED_TRACKED_DEVICES`). `groupEnabled > dmOnly` holds
 * structurally for every input.
 */
export function composeSessionMb({
  socketSlopeMb,
  signalMbPerContact,
  contacts,
  groupDevices,
  recordKb,
}: ComposeSessionMbInput): SessionMbProfile {
  const dmOnly = socketSlopeMb + signalMbPerContact * contacts;

  const effectiveGroupDevices = Math.max(groupDevices, MIN_GROUP_ENABLED_TRACKED_DEVICES);
  const groupEnabled = dmOnly + groupStateMb({ trackedDevices: effectiveGroupDevices, recordKb });

  return { dmOnly, groupEnabled };
}

const REDESIGN_THRESHOLD_MB = 60;

export interface RedesignThresholdResult {
  readonly exceeds: boolean;
  readonly reason: string;
}

/**
 * ADR 0018 Consequences: at a blended per-session cost of >= 60 MB, the 10k
 * fleet roughly doubles in boxes/cost - a founder-decision redesign fork,
 * not a silent scaling assumption. Returns the verdict plus a
 * human-readable reason string either way.
 */
export function exceedsRedesignThreshold(blendedMb: number): RedesignThresholdResult {
  const exceeds = blendedMb >= REDESIGN_THRESHOLD_MB;
  const reason = exceeds
    ? `blended ${blendedMb} MB/session is >= the ${REDESIGN_THRESHOLD_MB} MB redesign threshold - fleet box/cost roughly doubles at this scale (ADR 0018)`
    : `blended ${blendedMb} MB/session is below the ${REDESIGN_THRESHOLD_MB} MB redesign threshold`;
  return { exceeds, reason };
}
