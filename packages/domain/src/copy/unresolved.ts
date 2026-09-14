/**
 * unresolved.ts (P12 Unit U5) - verbatim user-facing copy for the human
 * two-choice path out of `blocked_needs_review` (the panel's Retry/Discard
 * action on an unresolved job the reconciler could not confirm). Source: the
 * blueprint's authoritative section states the panel entry has exactly
 * "Retry (may duplicate)" and "Discard (may have been delivered)" - ADR
 * 0013 constraint 7 uses the identical pair. Both strings below are
 * byte-for-byte that pair.
 *
 * Copy honesty (phase gotcha, verbatim, binding): the explanation says what
 * is true and nothing more - we could not confirm delivery, WhatsApp did not
 * acknowledge before the connection dropped, retrying may deliver it twice,
 * discarding may leave it unsent. No "guaranteed", no "never lost", no
 * blame on WhatsApp, no promised time. Scanned automatically by
 * `scripts/check-copy.ts` (clause (a)) via `COPY_GLOBS` - this module needs
 * no separate registration.
 */

export const UNRESOLVED_RETRY_BUTTON_COPY = 'Retry (may duplicate)';
export const UNRESOLVED_DISCARD_BUTTON_COPY = 'Discard (may have been delivered)';

export const UNRESOLVED_EXPLANATION_COPY =
  'We could not confirm delivery of this message. WhatsApp did not acknowledge it before the connection dropped. Retrying may deliver it twice. Discarding may leave it unsent.';
