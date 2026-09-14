import type { NotificationKind } from '../enums/index.js';

/**
 * notifications/dedupe-key.ts (P17 Unit U2, step 2) - the canonicalisation
 * half of the notification dedupe key: `sha256(kind + instanceId +
 * transitionId + bucket)`. `@wp/domain` must run unchanged in a browser and
 * ships no Node builtins (`.dependency-cruiser.cjs`'s `domain-must-be-pure-
 * core` rule forbids `node:crypto` - and any bare `crypto` - from
 * `packages/domain/src/**`, enforced as a real CI gate step). This module
 * therefore owns ONLY the pure, deterministic canonical STRING; the actual
 * `sha256(...)` wrapper is applied by the caller in a Node context - the
 * SAME split `content-hash.ts` (`contentHashInput`) and
 * `delivery-event-id.ts` (`deliveryEventIdInput`) already establish for
 * exactly this reason. A future app/backend unit computing
 * `buildNotificationDedupeKey` wraps this function's output with
 * `createHash('sha256').update(...).digest('hex')`, mirroring
 * `app/backend/src/engine/queue/content-hash.ts#computeContentHash`.
 *
 * `dedupeScope` (see `kinds.ts`) governs what a caller passes as
 * `transitionId`/`bucket`:
 *   - `'transition'` (all kinds except `plan_cap_reached`) - `transitionId`
 *     is a caller-provided TRANSITION IDENTITY (a pause/pacing_events row
 *     id, a job public id, a reconnect-exhaustion id) - NEVER a wall-clock
 *     value. `bucket` is omitted, EXCEPT `group_forbidden` (P24 C2 fix round,
 *     Fix 6), which passes its own enable-cycle bucket - the group's
 *     pre-disable `send_enabled_at` (ISO string), or `'never'` - so the same
 *     group re-enabled and forbidden again gets a fresh dedupe key instead of
 *     colliding with the first event's forever (`on-forbidden.ts`'s own doc).
 *   - `'instance-day'` (`plan_cap_reached` only) - a genuinely repeating
 *     daily condition, so the caller additionally passes the tenant-local
 *     date as `bucket`.
 *
 * Delimiter choice: parts are joined with `''` (no separator character) -
 * `kind` is a fixed snake_case enum label (no delimiter char could appear
 * in it), and `instanceId`/`transitionId` are UUIDs when present (also no
 * delimiter char), so a field-boundary collision cannot occur from ANY
 * character choice; using `''` rather than picking a specific delimiter
 * byte keeps the missing-segment ("instanceId omitted") case unambiguous by
 * construction - an empty segment is simply zero characters, not a
 * delimiter-adjacent placeholder.
 */
export interface NotificationDedupeKeyInput {
  readonly kind: NotificationKind;
  readonly instanceId?: string;
  readonly transitionId: string;
  readonly bucket?: string;
}

export function notificationDedupeKeyInput(input: NotificationDedupeKeyInput): string {
  const instanceSegment = input.instanceId ?? '';
  const bucketSegment = input.bucket ?? '';
  return `${input.kind}${instanceSegment}${input.transitionId}${bucketSegment}`;
}
