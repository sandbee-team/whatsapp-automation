/**
 * disconnect-map.ts (P08 U1 step 3) - the normative `DisconnectReason` ->
 * policy data table (wp-architecture SKILL.md §7, ADR 0013 constraint 6).
 *
 * This module is intentionally DATA ONLY: no reconnect logic, no timers, no
 * socket references. `resolveDisconnect` is a pure lookup. The reconnect
 * loop / backoff scheduler that CONSUMES this table lands in a later P08
 * unit; this table is its single source of truth for "may this code
 * auto-reconnect, and what health/link state does it imply".
 *
 * Numeric codes are library knowledge, re-derived from the pinned
 * `baileys@7.0.0-rc14` `DisconnectReason` enum (see `pinned.ts`). 402 and 406
 * are NOT live enum members in 7.0.0-rc14 (verified against the pinned
 * package) but are included here as extra rows per the normative disconnect
 * table (treated identically to 403 - a restriction-class signal) - they are
 * additive rows a future WhatsApp-side code could plausibly use; their
 * absence from the live enum does not weaken
 * `disconnect_map_covers_every_enum_member`, which only asserts coverage of
 * codes the enum ACTUALLY has today.
 *
 * NEVER auto-reconnect: 401, 402, 403, 406, 411, 440, 500 (ADR 0013
 * constraint 6, wp-architecture §7's health state machine, core invariant
 * 6 - no evasion, no automatic requeue around a restriction signal).
 */

export interface DisconnectPolicyRow {
  healthState: 'connected' | 'degraded' | 'paused' | 'logged_out';
  linkState: 'unchanged' | 'linked' | 'unlinked';
  autoReconnect: boolean;
  budget: 'backoff' | 'restart515' | 'none' | 'limited2';
  action: 'none' | 'purge_relink' | 'restriction_pause' | 'session_replaced' | 'unmapped';
  surfaceAsError: boolean;
  baseMultiplier?: number;
}

/**
 * The shorter-leash row for any disconnect code this table does not (yet)
 * know about: degrade immediately, and (per the reconnect loop's own budget
 * bookkeeping, not this table) pause after 2 attempts rather than the normal
 * transient budget - an unknown code is treated with MORE suspicion than a
 * known transient, never less.
 */
export const UNKNOWN_CODE_POLICY: DisconnectPolicyRow = Object.freeze({
  healthState: 'degraded',
  linkState: 'unchanged',
  autoReconnect: true,
  budget: 'limited2',
  action: 'unmapped',
  surfaceAsError: true,
});

export const DISCONNECT_MAP: Readonly<Record<number, DisconnectPolicyRow>> = Object.freeze({
  // 515 restartRequired - normal post-pairing reconnect. Stays "connected"
  // (never surfaced as degraded/error), immediate, its OWN separate budget
  // of 2 attempts with zero delay - never consumes the transient backoff budget.
  515: Object.freeze({
    healthState: 'connected',
    linkState: 'linked',
    autoReconnect: true,
    budget: 'restart515',
    action: 'none',
    surfaceAsError: false,
  }),
  // 428 connectionClosed - transient, backoff + jitter.
  428: Object.freeze({
    healthState: 'degraded',
    linkState: 'unchanged',
    autoReconnect: true,
    budget: 'backoff',
    action: 'none',
    surfaceAsError: true,
  }),
  // 408 - Baileys collapses connectionLost/timedOut onto the SAME numeric
  // code; this table never tries to distinguish them.
  408: Object.freeze({
    healthState: 'degraded',
    linkState: 'unchanged',
    autoReconnect: true,
    budget: 'backoff',
    action: 'none',
    surfaceAsError: true,
  }),
  // 503 unavailableService - transient, but backs off 5x slower (fleet-wide
  // outage handling itself is P09/P16 - this row only carries the
  // multiplier metadata for that later consumer).
  503: Object.freeze({
    healthState: 'degraded',
    linkState: 'unchanged',
    autoReconnect: true,
    budget: 'backoff',
    action: 'none',
    surfaceAsError: true,
    baseMultiplier: 5,
  }),
  // 440 connectionReplaced - NEVER auto-reconnect. Silent resolution is only
  // ever granted by the caller's own lease-fence comparison (expected
  // takeover within leaseTtl+grace) - this table has no opinion on that, it
  // only records the pessimistic default: paused, needs_user_action.
  440: Object.freeze({
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: 'none',
    action: 'session_replaced',
    surfaceAsError: true,
  }),
  // 401 loggedOut - NEVER auto-reconnect. Purge + RELINK_REQUIRED.
  401: Object.freeze({
    healthState: 'logged_out',
    linkState: 'unlinked',
    autoReconnect: false,
    budget: 'none',
    action: 'purge_relink',
    surfaceAsError: true,
  }),
  // 403 forbidden - restriction signal. NEVER auto-reconnect; jobs stay
  // queued; resume is a human-user action only (core invariant 6).
  403: Object.freeze({
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: 'none',
    action: 'restriction_pause',
    surfaceAsError: true,
  }),
  // 402 - treated as 403 (restriction-class signal). Not a live enum member
  // in 7.0.0-rc14 - see module doc comment.
  402: Object.freeze({
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: 'none',
    action: 'restriction_pause',
    surfaceAsError: true,
  }),
  // 406 - treated as 403 (restriction-class signal). Not a live enum member
  // in 7.0.0-rc14 - see module doc comment.
  406: Object.freeze({
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: 'none',
    action: 'restriction_pause',
    surfaceAsError: true,
  }),
  // 411 multideviceMismatch - NEVER auto-reconnect (reconnecting with a bad
  // device/session pairing loops forever). Purge + RELINK_REQUIRED.
  411: Object.freeze({
    healthState: 'logged_out',
    linkState: 'unlinked',
    autoReconnect: false,
    budget: 'none',
    action: 'purge_relink',
    surfaceAsError: true,
  }),
  // 500 badSession - NEVER auto-reconnect (reconnecting with bad creds loops
  // forever). Purge + RELINK_REQUIRED.
  500: Object.freeze({
    healthState: 'logged_out',
    linkState: 'unlinked',
    autoReconnect: false,
    budget: 'none',
    action: 'purge_relink',
    surfaceAsError: true,
  }),
});

/**
 * Pure lookup. `mapped: false` means the code was not found in
 * `DISCONNECT_MAP` - the caller gets `UNKNOWN_CODE_POLICY` back (a shorter
 * leash than any known transient) and is expected to log
 * `'disconnect.unmapped'` with the raw numeric code (never a QR/payload).
 */
export function resolveDisconnect(code: number): { row: DisconnectPolicyRow; mapped: boolean } {
  const row = DISCONNECT_MAP[code];
  if (row === undefined) {
    return { row: UNKNOWN_CODE_POLICY, mapped: false };
  }
  return { row, mapped: true };
}
