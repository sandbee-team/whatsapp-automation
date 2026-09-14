import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { createMessageHeadersSchema } from '../messages.js';
import { BROADCAST_DISCLOSURE } from '@wp/domain';

/**
 * app/broadcasts.ts (P23 Unit U2, step 3) - the tenant broadcast/campaign
 * surface. Money is `z.number().int()` PAISE everywhere (never a float,
 * never a decimal string parsed with `parseFloat` - same discipline as
 * `app/wallet.ts`). `.strict()` on every object schema so an unplanned
 * field cannot silently drift the wire shape. `listBroadcastsQuerySchema`
 * is keyset-only (`cursor` + `limit`, no `offset` field - see
 * `paginationInputSchema`'s own doc comment: OFFSET pagination is a lint
 * error).
 *
 * `broadcastMutationHeadersSchema` reuses `createMessageHeadersSchema`
 * verbatim (this package already has the mandatory-idempotency-header
 * idiom - see that schema's own header comment - rather than defining a
 * second, independently-drifting copy here).
 */

const contactsAudienceSchema = z
  .object({
    kind: z.literal('contacts'),
    tagIds: z.array(z.string().uuid()).max(50).optional(),
    contactIds: z.array(z.string().uuid()).max(20000).optional(),
  })
  .strict()
  .refine((value) => (value.tagIds?.length ?? 0) > 0 || (value.contactIds?.length ?? 0) > 0, {
    message: 'at least one of tagIds or contactIds must be non-empty',
  });

/**
 * P24 groups-messaging Unit U2: `groups` audience - `groupIds` is optional;
 * omitted/empty means every send-enabled group on the instance. `targetKind`
 * is NEVER a separate input field - it is DERIVED server-side from
 * `audience.kind` (a client can only choose an audience shape, never assert
 * a target kind independent of it).
 */
const groupsAudienceSchema = z
  .object({
    kind: z.literal('groups'),
    groupIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export const broadcastAudienceSchema = z.discriminatedUnion('kind', [
  contactsAudienceSchema,
  groupsAudienceSchema,
]);
export type BroadcastAudience = z.infer<typeof broadcastAudienceSchema>;

/** v1 supports text-only broadcast messages (no media, no template) - `kind` is a closed literal so a future kind is additive, never a silent widen. */
export const broadcastMessageSchema = z
  .object({
    kind: z.literal('text'),
    body: z.string().min(1).max(2000),
  })
  .strict();
export type BroadcastMessage = z.infer<typeof broadcastMessageSchema>;

export const createBroadcastInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    instanceId: z.string().uuid(),
    audience: broadcastAudienceSchema,
    message: broadcastMessageSchema,
    priority: z.enum(['high', 'normal', 'low']).default('low'),
    scheduledAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type CreateBroadcastInput = z.infer<typeof createBroadcastInputSchema>;

export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'snapshotting',
  'expanding',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;
export const broadcastStatusSchema = z.enum(BROADCAST_STATUSES);
export type BroadcastStatusContract = z.infer<typeof broadcastStatusSchema>;

export const BROADCAST_RECIPIENT_STATUSES = [
  'pending',
  'skipped',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
] as const;
export const broadcastRecipientStatusSchema = z.enum(BROADCAST_RECIPIENT_STATUSES);
export type BroadcastRecipientStatusContract = z.infer<typeof broadcastRecipientStatusSchema>;

/**
 * `deferred` is a DERIVED display bucket (computed at read time from a live
 * pacing-deny check) - it is NEVER a stored `campaign_recipients.status`
 * value (see `enums-exports.ts`'s own doc comment on
 * `BROADCAST_RECIPIENT_STATUSES` for why the stored enum has no such
 * label). It is included here only because the panel's progress bar needs
 * to show it.
 */
export const campaignCountersSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    read: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    /** Derived display bucket - never stored, see this schema's own header. */
    deferred: z.number().int().nonnegative(),
    chargedMinor: z.number().int().nonnegative(),
  })
  .strict();
export type CampaignCounters = z.infer<typeof campaignCountersSchema>;

export const broadcastSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    status: broadcastStatusSchema,
    instanceId: z.string().uuid(),
    priority: z.enum(['high', 'normal', 'low']),
    audienceCount: z.number().int().nonnegative().nullable(),
    quoteMinor: z.number().int().nonnegative().nullable(),
    priceKey: z.string().nullable(),
    scheduledAt: z.string().nullable(),
    snapshotDoneAt: z.string().nullable(),
    expandDoneAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type BroadcastSummary = z.infer<typeof broadcastSummarySchema>;

/** Every detail response carries the disclosure verbatim - `z.literal` so any drift from the single source fails validation, never silently ships a stale copy. */
export const broadcastDetailSchema = broadcastSummarySchema
  .extend({
    counters: campaignCountersSchema,
    disclosure: z.literal(BROADCAST_DISCLOSURE),
  })
  .strict();
export type BroadcastDetail = z.infer<typeof broadcastDetailSchema>;

export const listBroadcastsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    /** Coerced from string: Fastify hands `req.query` values as STRINGS (P26b finding c). */
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListBroadcastsQuery = z.infer<typeof listBroadcastsQuerySchema>;

export const cancelBroadcastInputSchema = z
  .object({
    reason: z.string().max(200).optional(),
  })
  .strict();
export type CancelBroadcastInput = z.infer<typeof cancelBroadcastInputSchema>;

export const restampInputSchema = z
  .object({
    confirmCount: z.number().int().nonnegative(),
  })
  .strict();
export type RestampInput = z.infer<typeof restampInputSchema>;

/** Reused verbatim from `messages.ts` - the mandatory-idempotency-header idiom, not a second independently-drifting copy. */
export const broadcastMutationHeadersSchema = createMessageHeadersSchema;
export type BroadcastMutationHeaders = z.infer<typeof broadcastMutationHeadersSchema>;

export const createBroadcastOutputSchema = successEnvelope(broadcastDetailSchema);
export type CreateBroadcastOutput = z.infer<typeof createBroadcastOutputSchema>;

export const createBroadcastContract = oc
  .route({ method: 'POST', path: '/v1/broadcasts' })
  .input(createBroadcastInputSchema)
  .output(createBroadcastOutputSchema);

/**
 * `data` is `{ items: [...] }`, never a bare array - the same keyset-list
 * envelope idiom as `listContactsOutputSchema`/`listContactTagsOutputSchema`
 * (`contacts.ts`) and `listWebhooksOutputSchema`. The keyset cursor travels
 * on `meta.nextCursor` (see `successEnvelope`'s own doc comment), never
 * inside `data` - matching `broadcasts.routes.ts`'s
 * `reply.send({ data: { items }, meta: { requestId, nextCursor? } })`.
 */
export const listBroadcastsOutputSchema = successEnvelope(
  z.object({ items: z.array(broadcastSummarySchema) }).strict(),
);
export type ListBroadcastsOutput = z.infer<typeof listBroadcastsOutputSchema>;

export const listBroadcastsContract = oc
  .route({ method: 'GET', path: '/v1/broadcasts' })
  .input(listBroadcastsQuerySchema)
  .output(listBroadcastsOutputSchema);

export const getBroadcastInputSchema = z.object({ id: z.string().uuid() }).strict();
export type GetBroadcastInput = z.infer<typeof getBroadcastInputSchema>;

export const getBroadcastOutputSchema = successEnvelope(broadcastDetailSchema);
export type GetBroadcastOutput = z.infer<typeof getBroadcastOutputSchema>;

export const getBroadcastContract = oc
  .route({ method: 'GET', path: '/v1/broadcasts/{id}' })
  .input(getBroadcastInputSchema)
  .output(getBroadcastOutputSchema);

export const cancelBroadcastOutputSchema = successEnvelope(broadcastDetailSchema);
export type CancelBroadcastOutput = z.infer<typeof cancelBroadcastOutputSchema>;

export const cancelBroadcastContract = oc
  .route({ method: 'POST', path: '/v1/broadcasts/{id}/cancel' })
  .input(cancelBroadcastInputSchema)
  .output(cancelBroadcastOutputSchema);

export const restampOutputSchema = successEnvelope(broadcastDetailSchema);
export type RestampOutput = z.infer<typeof restampOutputSchema>;

export const restampContract = oc
  .route({ method: 'POST', path: '/v1/broadcasts/{id}/restamp' })
  .input(restampInputSchema)
  .output(restampOutputSchema);

export const broadcastsContract = {
  create: createBroadcastContract,
  list: listBroadcastsContract,
  get: getBroadcastContract,
  cancel: cancelBroadcastContract,
  restamp: restampContract,
} as const;
