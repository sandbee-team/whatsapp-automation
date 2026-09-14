/**
 * constants.ts (P24 groups-messaging, Unit U2, step 1) - the group-sending
 * domain's shared numeric constants. Browser-pure (no Node builtins, no wall
 * clock) - same discipline as every other `@wp/domain` submodule.
 */

// Re-exported, never re-declared: the single source of truth for the
// 2,000-device tracked-participant budget already lives in
// `session/auth-key-types.ts` (P07 Unit U1). A second `= 2000` here would be
// exactly the kind of duplicated-constant drift core-invariants.md warns
// against - any future change to the budget must happen in ONE place.
export { MAX_TRACKED_GROUP_PARTICIPANT_DEVICES as MAX_TRACKED_PARTICIPANT_DEVICES } from '../session/auth-key-types.js';

/**
 * DERIVED, NOT MEASURED: a placeholder ratio of tracked devices per group
 * participant, taken from the scope delta's own qualitative estimate ("one
 * 184-participant group is on the order of 200-400 records") - 184 * 2 = 368
 * sits inside that band. P26 replaces this with a value measured from real
 * device-list fan-out; until then this constant must never be surfaced to a
 * customer as a precise figure (see `groups.budget.derivedNote` in
 * `@wp/i18n`, which exists specifically to keep this honest).
 */
export const DEVICES_PER_PARTICIPANT_ESTIMATE = 2;

/** At-most-once-per-hour group sync clock (one hour, in milliseconds). */
export const GROUP_SYNC_MIN_INTERVAL_MS = 3_600_000;
