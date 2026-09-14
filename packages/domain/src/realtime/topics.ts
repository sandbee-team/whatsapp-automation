/**
 * realtime/topics.ts (P15 U2, step 3) - the outbox backpressure drop-list.
 * ADR 0010: "Outbox backpressure policy: above 50,000 depth the relay drops
 * ephemeral topics (presence, typing indicators) but never job.*,
 * conversation.*, or instance.health.*." The relay's backpressure branch (a
 * later unit, `roles/relay.ts`) consumes this list read-only - it is the
 * ONLY set of topics allowed to be dropped under depth pressure.
 *
 * Each inclusion, one line:
 *   - `instance.pacing_changed` - a pacing-band-card refresh hint; the client
 *     always re-reads the authoritative pacing state through the API, so a
 *     dropped hint only delays a UI refresh, never loses pacing correctness.
 *   - `campaign.progress` - a progress-bar refresh hint; the campaign's real
 *     sent/queued/failed counts live in Postgres and are always re-fetched,
 *     so a dropped hint only delays the number on screen.
 *
 * Deliberately EXCLUDED (never add these without an ADR amendment):
 *   - `message.job.*` (job.* family) - "list invalidation" for jobs the
 *     tenant is actively waiting on; dropping it can hide a failure.
 *   - `chat.*` (conversation.* family) - inbox message hints; dropping it
 *     can hide an inbound message from the operator.
 *   - `instance.health_changed` - the mandatory pause/logged-out signal
 *     (blueprint: "Mandatory (not optional) notifications: pause (any
 *     cause), logged out ..."); this can never be silently dropped.
 *   - `job.needs_user_action` - the "Unresolved sends" list hint; silently
 *     dropping it strands a job the operator must act on.
 */
export const OUTBOX_EPHEMERAL_TOPICS = ['instance.pacing_changed', 'campaign.progress'] as const;

export type OutboxEphemeralTopic = (typeof OUTBOX_EPHEMERAL_TOPICS)[number];
