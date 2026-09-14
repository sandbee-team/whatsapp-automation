/**
 * Absolute platform pacing constants (P13 Unit U2, pacing design §4.1 -
 * the canon section is cited by number rather than by the product feature
 * name on purpose: `scripts/check-copy.ts` requires the full
 * `SAFE_MODE_DISCLAIMER` verbatim in ANY file naming that feature, and the
 * disclaimer is user-facing copy that has no business in a pure-domain
 * constants module. Same reasoning P11's interim floor module recorded for
 * the same guard.) These are the LAST clamp: `resolveEffective()`
 * (`resolve-effective.ts`) applies them AFTER `admin_relax`, the one layer
 * allowed to loosen anything. No configuration, tenant patch, warm-up tier,
 * health band or admin override may ever produce a value outside these -
 * that is the mechanism that makes core invariant 6 ("no provider-evasion
 * mechanism, ever") hold even for a purchasable/admin-granted relax: there
 * is no purchasable or admin path that reaches past this file.
 *
 * `db/migrations/0031_pacing_seed.sql` seeds the same numbers as data (the
 * DB is the runtime authority the reserve statement reads in-statement);
 * this module is the pure-domain copy `resolveEffective()` folds against.
 * The two must agree - see that migration's header comment, which points
 * back at this file by name.
 */

/**
 * The un-overridable minimum gap floor, in milliseconds. No tier, profile,
 * jitter draw, tenant patch or admin relax may ever produce a resolved
 * `gapMinMs` (nor a drawn gap, see `gap-jitter.ts`) below this value.
 *
 * Derived from the LOOSEST tier's own floor: `safe_default` tier 6 (the
 * most-warmed-up, least-restricted tier) has `gap_min_ms = 15000` - see the
 * table in `warmup-ladder.ts` and migration 0031's seeded row
 * `('safe_default', 6, ..., 15000, ...)`. Setting the absolute floor equal
 * to that value makes it a FLOOR, not a second cap: every tier's own
 * `gap_min_ms` is already `>= ABSOLUTE_GAP_MIN_MS`, so this constant never
 * binds tighter than a tier already does - it only exists to catch a
 * mis-seeded profile, a bad admin-relax patch, or a future tier addition
 * that would otherwise be able to push the gap below what any tier today
 * considers safe. Must stay `> 0` and `<= 15000` (tier 6's `gap_min_ms`).
 */
export const ABSOLUTE_GAP_MIN_MS = 15_000;

/**
 * No tier, profile, tenant patch or admin relax may push `dailyCap` above
 * this, ever - including through `admin_override` (design §4.1: admin
 * relax may loosen everything else, but never past the absolute ceiling).
 */
export const ABSOLUTE_DAILY_CEILING = 2_000;

/**
 * The group-send daily ceiling, in messages. Unlike `ABSOLUTE_DAILY_CEILING`
 * this one binds EVEN FOR ADMIN RELAX (scope delta § Groups, verbatim) -
 * `resolveEffective()` must clamp `groupDailyCap` against this constant
 * after applying `admin_override`, with no exception path.
 */
export const ABSOLUTE_GROUP_DAILY_CEILING = 50;

/**
 * Long-pause parameters (`gap-jitter.ts` § `applyLongPause`): every
 * `LONG_PAUSE_MIN_EVERY_N_SENDS`..`LONG_PAUSE_MAX_EVERY_N_SENDS` sends, the
 * next gap is multiplied by a `LONG_PAUSE_MULTIPLIER_MIN`..
 * `LONG_PAUSE_MULTIPLIER_MAX` factor, capped at `LONG_PAUSE_CAP_MS` - a
 * human-like "stepped away for a while" pause, never a shorter gap.
 */
export const LONG_PAUSE_MIN_EVERY_N_SENDS = 18;
export const LONG_PAUSE_MAX_EVERY_N_SENDS = 35;
export const LONG_PAUSE_MULTIPLIER_MIN = 4;
export const LONG_PAUSE_MULTIPLIER_MAX = 9;
export const LONG_PAUSE_CAP_MS = 15 * 60 * 1_000;
