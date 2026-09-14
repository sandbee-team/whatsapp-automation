/**
 * The three-field instance session FSM (P08 session/QR-linking): health,
 * link, and "needs user action" as pure functions over an `InstanceSnapshot`,
 * producing a `Transition` describing which fields to write plus which side
 * effects the caller (app/backend) must perform.
 *
 * `Transition` deliberately has NO `desiredState` field - structurally
 * impossible for any signal in this module to park an instance (core
 * invariant 6 / the "no code path may set desired_state='offline' in
 * response to any signal" rule). Parking is an explicit human action taken
 * elsewhere, never a side effect of a disconnect code or pairing outcome.
 *
 * States mirror the existing Postgres enum mirrors in `../enums/index.js`
 * (`WA_HEALTHS`, `WA_LINK_STATES`, `INSTANCE_DESIRED_STATES`) - this module
 * imports them rather than redeclaring the label sets.
 */
import type { WaHealth, WaLinkState, InstanceDesiredState } from '../enums/index.js';
import type { UserActionReason } from './user-action-reasons.js';

export interface InstanceSnapshot {
  healthState: WaHealth;
  linkState: WaLinkState;
  desiredState: InstanceDesiredState;
  needsUserAction: boolean;
  userActionReason: UserActionReason | null;
}

export type SideEffect = 'purge_auth' | 'audit' | 'notify' | 'end_socket' | 'release_lease';

/**
 * NO `desiredState` key - see module doc. Every other field is optional:
 * omitted means "leave that column alone".
 */
export interface Transition {
  healthState?: WaHealth;
  linkState?: WaLinkState;
  needsUserAction?: boolean;
  userActionReason?: UserActionReason | null;
  sideEffects: readonly SideEffect[];
}

/**
 * Structural shape of a disconnect-policy row, as read by `applyDisconnect`.
 * Domain does NOT import baileys or app/backend - the caller maps a raw
 * Baileys disconnect code to this shape first.
 *
 *   - `budget: 'restart515'` - the 515 `restartRequired` code's own,
 *     separate immediate budget of 2 (ADR 0013): stay connected/linked,
 *     surface nothing, for the first two occurrences in a row.
 *   - `budget: 'limited2'` - an unrecognized ("unknown") disconnect code:
 *     degrades on the first occurrence, pauses on the second.
 *   - `budget: null` - a row whose outcome (`action`) is unconditional
 *     (restriction, purge, session-replaced) and does not consume either
 *     numbered budget.
 */
export interface DisconnectPolicyRowLike {
  healthState: WaHealth;
  linkState: WaLinkState;
  autoReconnect: boolean;
  budget: 'restart515' | 'limited2' | null;
  action: 'stay' | 'reconnect' | 'restriction' | 'purge' | 'session_replaced';
  surfaceAsError: boolean;
}

export interface DisconnectBudgetCounters {
  restart515Used: number;
  unknownAttempts: number;
}

export interface ApplyDisconnectContext {
  expectedTakeover?: boolean;
}

/**
 * Legal (from, to) pairs for `healthState` and `linkState`, kept as explicit
 * data so an undeclared edge can never sneak through and so the graph is
 * inspectable/testable at once (same pattern as `job/state-machine.ts`).
 */
const LEGAL_HEALTH_TRANSITIONS: Readonly<Record<WaHealth, readonly WaHealth[]>> = Object.freeze({
  never_linked: Object.freeze<WaHealth[]>(['connected']),
  connected: Object.freeze<WaHealth[]>(['degraded', 'paused', 'logged_out']),
  degraded: Object.freeze<WaHealth[]>(['connected', 'paused', 'logged_out']),
  paused: Object.freeze<WaHealth[]>(['connected', 'logged_out']),
  logged_out: Object.freeze<WaHealth[]>(['connected']),
});

const LEGAL_LINK_TRANSITIONS: Readonly<Record<WaLinkState, readonly WaLinkState[]>> = Object.freeze(
  {
    unlinked: Object.freeze<WaLinkState[]>(['pairing']),
    pairing: Object.freeze<WaLinkState[]>(['linked', 'unlinked']),
    linked: Object.freeze<WaLinkState[]>(['unlinked']),
  },
);

function assertLegalHealth(from: WaHealth, to: WaHealth): void {
  if (!LEGAL_HEALTH_TRANSITIONS[from].includes(to)) {
    throw new RangeError(`session-fsm: illegal health transition ${from} -> ${to}`);
  }
}

function assertLegalLink(from: WaLinkState, to: WaLinkState): void {
  if (!LEGAL_LINK_TRANSITIONS[from].includes(to)) {
    throw new RangeError(`session-fsm: illegal link transition ${from} -> ${to}`);
  }
}

/** unlinked/never_linked -> pairing: only linkState (+ side effects) moves. */
export function beginPairing(snap: InstanceSnapshot): Transition {
  assertLegalLink(snap.linkState, 'pairing');
  return {
    linkState: 'pairing',
    needsUserAction: false,
    userActionReason: null,
    sideEffects: [],
  };
}

/**
 * pairing -> linked, and (the one place health also moves alongside link in
 * a non-purge transition) never_linked/degraded/paused -> connected. This is
 * intentionally its own legal pair, distinct from the purge exception
 * (logged_out+unlinked) - a fresh successful pairing legitimately resolves
 * both fields at once.
 */
export function pairingSucceeded(snap: InstanceSnapshot): Transition {
  assertLegalLink(snap.linkState, 'linked');
  assertLegalHealth(snap.healthState, 'connected');
  return {
    healthState: 'connected',
    linkState: 'linked',
    needsUserAction: false,
    userActionReason: null,
    sideEffects: ['audit'],
  };
}

/** pairing -> unlinked, needs user action (PAIRING_EXPIRED). Link only. */
export function pairingExpired(snap: InstanceSnapshot): Transition {
  assertLegalLink(snap.linkState, 'unlinked');
  return {
    linkState: 'unlinked',
    needsUserAction: true,
    userActionReason: 'PAIRING_EXPIRED',
    sideEffects: ['audit', 'notify'],
  };
}

export function applyDisconnect(
  row: DisconnectPolicyRowLike,
  ctx: DisconnectBudgetCounters,
  options: ApplyDisconnectContext = {},
): Transition & DisconnectBudgetCounters {
  if (row.budget === 'restart515') {
    return applyRestart515(ctx);
  }
  if (row.budget === 'limited2') {
    return applyUnknown(ctx);
  }

  switch (row.action) {
    case 'restriction':
      return {
        healthState: 'paused',
        needsUserAction: true,
        userActionReason: 'RESTRICTION_SIGNAL',
        sideEffects: ['audit', 'notify'],
        ...ctx,
      };
    case 'purge':
      return {
        healthState: 'logged_out',
        linkState: 'unlinked',
        needsUserAction: true,
        userActionReason: 'RELINK_REQUIRED',
        sideEffects: ['purge_auth', 'audit', 'notify'],
        ...ctx,
      };
    case 'session_replaced':
      if (options.expectedTakeover === true) {
        return { sideEffects: ['end_socket'], ...ctx };
      }
      return {
        healthState: 'paused',
        needsUserAction: true,
        userActionReason: 'SESSION_REPLACED',
        sideEffects: ['audit', 'notify'],
        ...ctx,
      };
    default:
      // Fail-safe default (core invariant 2): an unrecognized row.action
      // that also isn't one of the numbered budgets pauses rather than
      // silently continuing.
      return {
        healthState: 'paused',
        needsUserAction: true,
        userActionReason: 'RECONNECT_FAILED',
        sideEffects: ['audit', 'notify'],
        ...ctx,
      };
  }
}

function applyRestart515(ctx: DisconnectBudgetCounters): Transition & DisconnectBudgetCounters {
  const usedAfter = ctx.restart515Used + 1;
  if (usedAfter <= 2) {
    // Stay connected/linked, surface nothing - its own separate budget.
    return { sideEffects: [], restart515Used: usedAfter, unknownAttempts: ctx.unknownAttempts };
  }
  // Beyond its budget of 2: escalate, treated as an unknown disconnect from
  // here rather than a silent stay.
  return applyUnknown({ ...ctx, restart515Used: usedAfter });
}

function applyUnknown(ctx: DisconnectBudgetCounters): Transition & DisconnectBudgetCounters {
  const attemptsAfter = ctx.unknownAttempts + 1;
  if (attemptsAfter < 2) {
    return {
      healthState: 'degraded',
      sideEffects: [],
      restart515Used: ctx.restart515Used,
      unknownAttempts: attemptsAfter,
    };
  }
  return {
    healthState: 'paused',
    needsUserAction: true,
    userActionReason: 'RECONNECT_FAILED',
    sideEffects: ['audit', 'notify'],
    restart515Used: ctx.restart515Used,
    unknownAttempts: attemptsAfter,
  };
}
