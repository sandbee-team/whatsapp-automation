import { PARKED_COPY } from './instance-copy.js';

/**
 * send-copy.ts (P11 send-path-mvp, step 2) - verbatim user-facing copy for
 * the send/composer surface. Source: the phase's own binding gotcha
 * (verbatim): "Honest composer copy. 'Queued — will send from your
 * connected number' and, for an offline account, the parked/offline wording
 * from `@wp/domain`. No delivery-time promise, no 'instant', nothing from
 * `BANNED_CLAIMS`, and never a tick on an unsent message. All strings go
 * through `check-copy`."
 *
 * Both strings are scanned automatically by `scripts/check-copy.ts` (clause
 * (a), the banned-claims scan over the whole shipped tree via `SCAN_GLOBS`
 * - this module needs no separate registration, only honest wording).
 */

/**
 * Shown in the composer immediately after a send request is accepted
 * (`201 { data: { id, status: "queued" } }`). Never a delivery-time or
 * "instant" promise - a job is durable-first (core invariant 1): it is
 * QUEUED, not yet sent, and must never render as a sent/delivered tick.
 */
export const COMPOSER_QUEUED_COPY = 'Queued — will send from your connected number';

/**
 * Shown when a send is accepted for an `offline` (parked) instance - the
 * `202 INSTANCE_OFFLINE` response path (blueprint: jobs created for an
 * offline instance still return success and remain queued, core invariant
 * 5: pause/park never loses queued work). Reuses `PARKED_COPY` verbatim
 * rather than a second, independently-worded string - one honest wording
 * for "this number is not currently connected", not two to drift apart.
 */
export const INSTANCE_OFFLINE_COPY = PARKED_COPY;
