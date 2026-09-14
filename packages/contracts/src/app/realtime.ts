import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  WA_HEALTHS,
  PAUSE_REASONS,
  JOB_STATUSES,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
} from '@wp/domain';

/**
 * packages/contracts/src/app/realtime.ts (P05 Unit U3a) - the six real-time
 * event payload schemas the SSE stream (`GET /v1/events`) carries. Blueprint
 * "Real-time & notifications" table (canon, binding): payloads are ids and
 * enums only - the client always refetches business detail through the
 * authorised API, never trusts an event body for anything beyond "something
 * changed, go look". Every schema below is `.strict()` so an unexpected key
 * (e.g. a phone number or message body smuggled onto a payload) fails
 * validation rather than silently passing through - see
 * `tests/realtime-events.test.ts`'s `an_event_payload_with_a_phone_number_field_is_rejected`.
 *
 * `jobPublicId` reuses the same free-form non-empty string shape
 * `message_jobs` public ids use elsewhere in this codebase (no dedicated
 * `publicId` zod helper exists yet anywhere under packages/contracts - grepped,
 * none found - so this is defined locally rather than imported).
 */

const jobPublicIdSchema = z.string().min(1).max(64);

const nonNegativeInt = z.number().int().nonnegative();

const bandSchema = z.enum(['HIGH', 'NORMAL', 'LOW']);

const instanceQrEventSchema = z
  .object({
    type: z.literal('instance.qr'),
    instanceId: z.uuid(),
    expiresAt: z.iso.datetime(),
    attemptsLeft: nonNegativeInt,
    /**
     * The QR/pairing-code string itself (P08 U5) - a BEARER CREDENTIAL, not
     * an id/enum. This is its ONE sink: the SSE publish call that reaches
     * only the owning tenant's channel. Deliberately exempt from the
     * ids-only length/shape checks `assertIdsOnly` applies to every other
     * field (see `REALTIME_OPAQUE_PAYLOAD_KEYS` in
     * `@wp/domain`'s `assert-ids-only.ts`) - it must never be logged,
     * metriced, or written to audit metadata.
     */
    payload: z.string(),
  })
  .strict();

const instanceHealthChangedEventSchema = z
  .object({
    type: z.literal('instance.health_changed'),
    instanceId: z.uuid(),
    healthState: z.enum(WA_HEALTHS),
    pauseReason: z.enum(PAUSE_REASONS).nullable(),
    needsUserAction: z.boolean(),
  })
  .strict();

const instancePacingChangedEventSchema = z
  .object({
    type: z.literal('instance.pacing_changed'),
    instanceId: z.uuid(),
    band: bandSchema,
    tier: nonNegativeInt,
    effDailyCap: nonNegativeInt,
    configVersion: nonNegativeInt,
  })
  .strict();

const messageJobStatusChangedEventSchema = z
  .object({
    type: z.literal('message.job.status_changed'),
    jobPublicId: jobPublicIdSchema,
    instanceId: z.uuid(),
    status: z.enum(JOB_STATUSES),
  })
  .strict();

const jobNeedsUserActionReasonSchema = z.enum([
  'duplicate_fanout_ack_required',
  'unresolved_send',
  'manual_review_required',
]);

const jobNeedsUserActionEventSchema = z
  .object({
    type: z.literal('job.needs_user_action'),
    jobPublicId: jobPublicIdSchema,
    reason: jobNeedsUserActionReasonSchema,
  })
  .strict();

const campaignProgressEventSchema = z
  .object({
    type: z.literal('campaign.progress'),
    campaignId: z.uuid(),
    sent: nonNegativeInt,
    queued: nonNegativeInt,
    failed: nonNegativeInt,
  })
  .strict();

/**
 * `webhook.endpoint_disabled` (P15 U5, step 7) - fired when the dispatcher
 * auto-disables an endpoint at 20 consecutive terminal failures. `fanout:
 * ['sse']` ONLY (never `webhook`) - a disabled endpoint cannot receive its
 * own disablement notice, so this is never subscribable via
 * `WEBHOOK_EVENT_TYPES` (webhooks.ts derives that list from
 * `REALTIME_EVENT_TYPES` minus `instance.qr` only - this type is excluded
 * there explicitly, see that module's own comment). Ids/enums only:
 * `endpointId` is the only field, same "go look, never trust the payload
 * for detail" shape as every other event here.
 */
const webhookEndpointDisabledEventSchema = z
  .object({
    type: z.literal('webhook.endpoint_disabled'),
    endpointId: z.uuid(),
  })
  .strict();

/**
 * `notification.created` (P17 Unit U2, step 2) - fired when a new row lands
 * in `notifications` for the caller's tenant. `instanceId` is optional (not
 * every kind is instance-scoped, e.g. `plan_cap_reached` at the client
 * level) - the client always refetches the notification list/unread-count
 * through the authorised API, same "go look" rule as every other event
 * here.
 */
const notificationCreatedEventSchema = z
  .object({
    type: z.literal('notification.created'),
    notificationId: z.uuid(),
    kind: z.enum(NOTIFICATION_KINDS),
    severity: z.enum(NOTIFICATION_SEVERITIES),
    instanceId: z.uuid().optional(),
  })
  .strict();

export const realtimeEventSchema = z.discriminatedUnion('type', [
  instanceQrEventSchema,
  instanceHealthChangedEventSchema,
  instancePacingChangedEventSchema,
  messageJobStatusChangedEventSchema,
  jobNeedsUserActionEventSchema,
  campaignProgressEventSchema,
  webhookEndpointDisabledEventSchema,
  notificationCreatedEventSchema,
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export const REALTIME_EVENT_TYPES = [
  'instance.qr',
  'instance.health_changed',
  'instance.pacing_changed',
  'message.job.status_changed',
  'job.needs_user_action',
  'campaign.progress',
  'webhook.endpoint_disabled',
  'notification.created',
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * One SSE wire frame: `id:`/`event:`/`data:` fields (ADR 0010 - the browser
 * client opens the stream with `fetch()` + `Authorization` header, resumes
 * with `Last-Event-ID`, and always refetches business detail through the
 * authorised API - this schema is the parsed shape of one frame's `data`
 * payload plus its envelope, not a wire-format serializer).
 */
export const realtimeFrameSchema = z.object({
  id: z.string(),
  event: z.enum(REALTIME_EVENT_TYPES),
  data: realtimeEventSchema,
});

export type RealtimeFrame = z.infer<typeof realtimeFrameSchema>;

/**
 * The `batch` frame (P15 U2, step 3) - the outbox relay's coalesced fan-out
 * shape (ADR 0010 / phase P15: "at most one frame per (client, instance) per
 * tick"). `events` carries newest-wins winners for the tick, capped at 25
 * (`P15 dispatch plan`: "> 25 keys -> truncated:true and the client
 * refetches"). `.strict()` and ids/enums-only exactly like every other
 * frame: each member of `events` is validated against the SAME
 * `realtimeEventSchema` union the single-event frame uses - the batch frame
 * never carries a new, unvalidated payload shape of its own. Both sides of
 * the cross-process bridge (`modules/realtime/redis-bridge.ts`) accept this
 * frame once the relay unit (P15 U4) starts publishing it.
 */
const MAX_BATCH_FRAME_EVENTS = 25;

export const batchFrameSchema = z
  .object({
    v: z.literal(1),
    events: z.array(realtimeEventSchema).max(MAX_BATCH_FRAME_EVENTS),
    truncated: z.boolean(),
  })
  .strict();

export type BatchFrame = z.infer<typeof batchFrameSchema>;

/**
 * `GET /v1/events` - no output schema: this is a stream, not a single JSON
 * response, so there is nothing for `@orpc/contract`'s `.output(...)` to
 * validate against. See ADR 0010 / phase risks doc: the browser opens this
 * with `fetch()` + a real `Authorization: Bearer <token>` header (EventSource
 * cannot send one), so this is a NORMAL `registerRoute` route, `policy:
 * 'session'`, exactly like every other authenticated route.
 */
export const realtimeEventsContract = oc.route({ method: 'GET', path: '/v1/events' });

export const realtimeContract = {
  events: realtimeEventsContract,
} as const;
