/**
 * Verbatim user-facing copy for the `INFRA_UNAVAILABLE` panel state (P09
 * session-fleet-and-drain, discovery's 3-consecutive-cycle escalation - see
 * `USER_ACTION_REASONS` in `../instance/user-action-reasons.js`). Follows
 * `instance-copy.ts`'s own precedent: a single verbatim English string, no
 * en/hi split (that file's `PARKED_COPY`/`PARKED_BUFFER_CAVEAT` are English-
 * only too - this phase does not introduce a Hinglish variant for this
 * string).
 *
 * Honest per `.claude/skills/safety-compliance/SKILL.md`: never blames
 * WhatsApp/the provider, never promises a recovery time, never makes any
 * restriction-avoidance or delivery-guarantee claim (core invariant 6) -
 * states only that OUR system could not keep the number connected right
 * now, and that queued work is preserved (core invariant 5).
 */
export const INFRA_UNAVAILABLE_COPY =
  'We could not keep this number connected right now. Queued messages are safe and will send when it reconnects.';
