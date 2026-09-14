/**
 * realtime/coalesce.ts (P15 U2, step 3) - the coalesce-key derivation the
 * outbox relay uses to fold many outbox rows for the same logical "state
 * hint" into the newest-wins winner before it ever reaches an SSE frame
 * (ADR 0010's coalescing policy; `.claude/skills/queue-engineering/SKILL.md`
 * Outbox pattern). This module owns the ONE derivation - relay's coalescer
 * (a later unit) groups outbox rows by this key and keeps only the highest
 * `id` per key, never re-deriving the shape itself.
 *
 * Four coalesce-key shapes, one per outbox event "family":
 *   - `instance:<id>:state`  - instance health/pacing/link state hints
 *     (`instance.health_changed`, `instance.pacing_changed`).
 *   - `instance:<id>:jobs`   - per-instance job-status-changed hints
 *     (`message.job.status_changed` and friends) - many jobs on one
 *     instance coalesce to one "your job list changed, refetch" hint.
 *   - `chat:<id>`            - per-conversation hints (future P17 inbox
 *     event family; `entityId` here is the chat id).
 *   - `campaign:<id>:progress` - per-campaign progress hints
 *     (`campaign.progress`; `entityId`/`campaignId` is the campaign id).
 *   - `n:<id>`                - per-notification hints (P17 Unit U2,
 *     `notification.created`; `entityId` is the notification id) - unique
 *     PER NOTIFICATION so retries of the same row coalesce but distinct
 *     notifications never do (each notification is its own actionable
 *     item, unlike the "go refetch the list" hints above).
 *
 * `instance.qr` and any event with `fanout` that excludes `sse` never reach
 * this function in practice (the outbox CHECK requires a coalesce_key only
 * when `sse` is in `fanout`, and `emit()` rejects `instance.qr` outright -
 * see `app/backend/src/modules/events/emit.ts`) - but this function itself
 * stays a pure, total mapping so a caller can always ask "what key would
 * this event coalesce under" without first checking fanout.
 *
 * Browser-pure: no Node builtins, no I/O.
 */

/**
 * The minimal shape `coalesceKeyFor` needs - deliberately NOT the six SSE
 * payload schemas from `@wp/contracts`' `realtimeEventSchema` (this module
 * cannot depend on `@wp/contracts` without inverting the dependency graph;
 * `@wp/contracts` already depends on `@wp/domain`). Mirrors `emit()`'s own
 * input fields (`type`, `instanceId`, `entityId`) - the outbox row shape,
 * not the wire frame shape.
 */
export interface CoalesceKeyInput {
  type: string;
  instanceId?: string;
  entityId: string;
}

const INSTANCE_STATE_TYPES = new Set([
  'instance.health_changed',
  'instance.pacing_changed',
  // P16 Unit C - hard-signal-pause's own event; same "instance state hint"
  // family as the other two.
  'instance.paused',
  // P16 Unit D (step 8) - human-resume's own event; same family.
  'instance.resumed',
]);

const INSTANCE_JOBS_TYPE_PREFIX = 'message.job.';

const CAMPAIGN_PROGRESS_TYPE = 'campaign.progress';

const CHAT_TYPE_PREFIX = 'chat.';

const NOTIFICATION_CREATED_TYPE = 'notification.created';

/**
 * Derives the coalesce key for `event`. Throws for a type this module does
 * not recognise as coalescable, rather than silently returning a key that
 * would wrongly fold unrelated events together - every caller must extend
 * this function explicitly when a new event family needs coalescing.
 */
export function coalesceKeyFor(event: CoalesceKeyInput): string {
  if (INSTANCE_STATE_TYPES.has(event.type)) {
    if (event.instanceId === undefined) {
      throw new Error(`coalesceKeyFor: "${event.type}" requires instanceId`);
    }
    return `instance:${event.instanceId}:state`;
  }

  if (event.type.startsWith(INSTANCE_JOBS_TYPE_PREFIX)) {
    if (event.instanceId === undefined) {
      throw new Error(`coalesceKeyFor: "${event.type}" requires instanceId`);
    }
    return `instance:${event.instanceId}:jobs`;
  }

  if (event.type.startsWith(CHAT_TYPE_PREFIX)) {
    return `chat:${event.entityId}`;
  }

  if (event.type === CAMPAIGN_PROGRESS_TYPE) {
    return `campaign:${event.entityId}:progress`;
  }

  if (event.type === NOTIFICATION_CREATED_TYPE) {
    return `n:${event.entityId}`;
  }

  throw new Error(`coalesceKeyFor: no coalesce-key shape known for event type "${event.type}"`);
}
