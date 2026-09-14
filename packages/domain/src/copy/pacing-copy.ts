/**
 * pacing-copy.ts (P13a Unit U1, step 1) - verbatim user-facing pacing/warm-up
 * notification copy (canon design §5, timeline §2.5). No caller may hand-roll
 * a warm-up/pacing status string; every one is imported from here.
 * `scripts/check-copy.ts` scans this file's own text on disk for the literal
 * "Safe Mode" substring, so the disclaimer literal has to live in THIS file's
 * source bytes, not just be reachable through an import - same idiom as
 * `onboarding.ts`'s own `SAFE_MODE_DISCLAIMER_LITERAL` (a test proves the two
 * stay byte-identical).
 *
 * Every string here states: what happened, what is preserved (queued work is
 * never lost - core invariant 5), when it resumes, and what the user can do -
 * and NEVER promises prevention/avoidance of a WhatsApp restriction
 * (invariant 6). `warmup_rolled_back` in particular never mentions bans.
 */

const SAFE_MODE_DISCLAIMER_LITERAL = `Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.`;

/** Canon design §5, verbatim. Shown while an instance is progressing through the six-tier warm-up ladder. */
const WARMUP_IN_PROGRESS =
  'Warm-up {tier} of 6 — day {day}. New numbers send slowly on purpose: ' +
  "today's limit is {cap} messages with a {gapMin}–{gapMax}s gap between them. " +
  'Limits increase on {nextStepDate} if this number stays healthy. ' +
  'This lowers the risk of spam signals from a cold number; it is not a guarantee.';

/** Canon design §5, verbatim. Shown while `watch` freezes warm-up advancement. */
const WARMUP_FROZEN_WATCH =
  "Warm-up is on hold while this number's health recovers. Current limits stay in place. " +
  'We will look again in {hours} h.';

/**
 * §2.5 timeline shape - shown when a `WARMUP_ADVANCE` event is applied.
 * States what happened (moved tier), the evidence (days elapsed, health
 * score/band), and the fact that no restriction signal blocked it - never a
 * promise about the future.
 */
const WARMUP_ADVANCED =
  'Day {day} — moved to Warm-up {tier}: {days} days elapsed, health {score} ({band}), ' +
  'no restriction signals.';

/**
 * Shown when a `WARMUP_ROLLBACK` event is applied. States what happened
 * (limits tightened one step), that queued messages are safe (invariant 5),
 * when normal progress resumes, and what the user can do - never a claim
 * about bans/restrictions being caused or avoided.
 */
const WARMUP_ROLLED_BACK =
  'Warm-up stepped back one level to Warm-up {tier} because this number’s health ' +
  'dropped to {band}. Your queued messages are safe and stay queued — nothing is lost. ' +
  'Sending continues at the lower limit while health recovers; warm-up progress resumes ' +
  'automatically once the account is healthy again. Check the instance health page for ' +
  "today's signals, or contact support if this repeats.";

/**
 * P16 step 10 (health-signals-and-pause, design §5) - pause/band/resume
 * copy. Same rule as the warm-up strings above: state what happened, what is
 * preserved (invariant 5), when it resumes, and what the user can do - NEVER
 * a restriction-avoidance or ban-outcome promise (invariant 6). None of the
 * five strings below mentions a timer, a retry window, or any claim of
 * immunity to a WhatsApp restriction - `pacing-copy.test.ts`'s own drift
 * guard pins this.
 */
const INSTANCE_PAUSED_RESTRICTION =
  'Sending paused — WhatsApp returned a restriction signal for this number. We have ' +
  'stopped all sending on it and kept your {queued} queued messages. Please open WhatsApp ' +
  'on the phone for this number, check for any notice from WhatsApp, and resolve it there. ' +
  'Sending will not restart by itself — you must resume it here after you have checked.';

const HEALTH_WATCH =
  'We are watching this number. Health {score}/100 — {topReason}. Limits have been ' +
  'reduced to {cap} messages a day and the gap between messages increased while things ' +
  'settle. No action needed from you yet.';

const HEALTH_DEGRADED =
  "This number's health has dropped to {score}/100 — {topReason}. We have cut today's " +
  'limit to {cap}, slowed sending, and stopped new first-time conversations. Replies to ' +
  'people who messaged you keep working. Your queued messages are safe. Reviewing your ' +
  'recent message content and recipient list is the fastest way to recover.';

const HEALTH_CRITICAL_PAUSED =
  "Sending paused automatically — this number's health is {score}/100 ({topReason}). " +
  'All {queued} queued messages are preserved. Please review your recent sending, then ' +
  'resume when you are ready. We do not restart sending on our own.';

/**
 * Resume-confirmation (restriction ack checkbox) copy - states plainly that
 * the tenant must have checked the number in the WhatsApp app, that queued
 * messages are preserved, and that WP cannot appeal to WhatsApp on their
 * behalf. NO timer, NO "retry in 24h", NO recovery promise, and nothing
 * resembling an immunity-to-restriction claim.
 */
const RESUME_CONFIRM =
  'By resuming, you confirm you have opened WhatsApp on the phone for this number and ' +
  'checked for any notice from WhatsApp. Your queued messages have been preserved the ' +
  'whole time and will start sending again once you resume. WP cannot appeal a WhatsApp ' +
  'restriction or contact WhatsApp on your behalf — only you, in the WhatsApp app, can do that.';

export const PACING_COPY = Object.freeze({
  /** Byte-identical to `SAFE_MODE_DISCLAIMER` from disclosures.ts - see module doc above. */
  safeModeDisclaimer: SAFE_MODE_DISCLAIMER_LITERAL,
  warmupInProgress: WARMUP_IN_PROGRESS,
  warmupFrozenWatch: WARMUP_FROZEN_WATCH,
  warmupAdvanced: WARMUP_ADVANCED,
  warmupRolledBack: WARMUP_ROLLED_BACK,
  instancePausedRestriction: INSTANCE_PAUSED_RESTRICTION,
  healthWatch: HEALTH_WATCH,
  healthDegraded: HEALTH_DEGRADED,
  healthCriticalPaused: HEALTH_CRITICAL_PAUSED,
  resumeConfirm: RESUME_CONFIRM,
});

export type PacingCopy = typeof PACING_COPY;
