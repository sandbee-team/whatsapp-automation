import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope, paginationInputSchema } from '../envelope.js';
import { REALTIME_EVENT_TYPES } from './realtime.js';

/**
 * webhooks.ts (P15 U2, step 3) - `webhook_endpoints` CRUD contracts.
 * Design doc §6.4: `webhook_endpoints(id, client_id, url, secret_enc,
 * events text[], enabled, created_at, last_success_at,
 * consecutive_failures, disabled_reason)`. This module owns the wire
 * shapes only - signing, SSRF-guarded dispatch, and the delivery table
 * belong to `modules/webhooks` (a later unit, U5); nothing here reaches a
 * network or opens a connection.
 *
 * `WEBHOOK_EVENT_TYPES` is `REALTIME_EVENT_TYPES` MINUS `instance.qr` and
 * MINUS `webhook.endpoint_disabled` - a QR is a bearer credential that never
 * enters the outbox (`emit()` rejects it outright, see
 * `app/backend/src/modules/events/emit.ts`); `webhook.endpoint_disabled`
 * (P15 U5, step 7) is fanned to `sse` only (a disabled endpoint cannot
 * receive its own disablement notice, see `realtime.ts`'s own doc comment
 * on that event), so neither is ever a webhook-subscribable event type.
 * `events` on create/patch is validated against this same restricted union
 * - an unknown or excluded event name is a validation error, not a
 * silently-ignored subscription.
 *
 * The endpoint's raw secret is NEVER part of any output schema here (only
 * `secretEnc`'s existence is implied by `enabled`/config state, never
 * echoed back) - "secrets shown once" (phase goal line) is enforced at the
 * create-response layer by `modules/webhooks` (later unit), not by this
 * contract needing a `secret` output field at all beyond creation.
 */

const WEBHOOK_EXCLUDED_EVENT_TYPES = new Set(['instance.qr', 'webhook.endpoint_disabled']);

export const WEBHOOK_EVENT_TYPES = REALTIME_EVENT_TYPES.filter(
  (type) => !WEBHOOK_EXCLUDED_EVENT_TYPES.has(type),
) as readonly Exclude<
  (typeof REALTIME_EVENT_TYPES)[number],
  'instance.qr' | 'webhook.endpoint_disabled'
>[];

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048);

const webhookEventsInputSchema = z
  .array(webhookEventTypeSchema)
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length);

// ---------------------------------------------------------------------
// POST /v1/webhooks/endpoints
// ---------------------------------------------------------------------

export const createWebhookEndpointInputSchema = z
  .object({
    url: httpsUrlSchema,
    events: webhookEventsInputSchema,
  })
  .strict();
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointInputSchema>;

/** The endpoint's `secret`, in the clear, appears ONLY in the create response - "secrets shown once". */
export const createWebhookEndpointOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    url: httpsUrlSchema,
    events: webhookEventsInputSchema,
    enabled: z.boolean(),
    secret: z.string(),
  }),
);
export type CreateWebhookEndpointOutput = z.infer<typeof createWebhookEndpointOutputSchema>;

export const createWebhookEndpointContract = oc
  .route({ method: 'POST', path: '/v1/webhooks/endpoints' })
  .input(createWebhookEndpointInputSchema)
  .output(createWebhookEndpointOutputSchema);

// ---------------------------------------------------------------------
// PATCH /v1/webhooks/endpoints/:id
// ---------------------------------------------------------------------

export const patchWebhookEndpointInputSchema = z
  .object({
    id: z.uuid(),
    url: httpsUrlSchema.optional(),
    events: webhookEventsInputSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type PatchWebhookEndpointInput = z.infer<typeof patchWebhookEndpointInputSchema>;

const webhookEndpointSummarySchema = z.object({
  id: z.uuid(),
  url: httpsUrlSchema,
  events: webhookEventsInputSchema,
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  disabledReason: z.string().nullable(),
});

export const patchWebhookEndpointOutputSchema = successEnvelope(webhookEndpointSummarySchema);
export type PatchWebhookEndpointOutput = z.infer<typeof patchWebhookEndpointOutputSchema>;

export const patchWebhookEndpointContract = oc
  .route({ method: 'PATCH', path: '/v1/webhooks/endpoints/{id}' })
  .input(patchWebhookEndpointInputSchema)
  .output(patchWebhookEndpointOutputSchema);

// ---------------------------------------------------------------------
// GET /v1/webhooks/endpoints
// ---------------------------------------------------------------------

export const listWebhookEndpointsInputSchema = paginationInputSchema;
export type ListWebhookEndpointsInput = z.infer<typeof listWebhookEndpointsInputSchema>;

export const listWebhookEndpointsOutputSchema = successEnvelope(
  z.object({
    items: z.array(webhookEndpointSummarySchema),
  }),
);
export type ListWebhookEndpointsOutput = z.infer<typeof listWebhookEndpointsOutputSchema>;

export const listWebhookEndpointsContract = oc
  .route({ method: 'GET', path: '/v1/webhooks/endpoints' })
  .input(listWebhookEndpointsInputSchema)
  .output(listWebhookEndpointsOutputSchema);

// ---------------------------------------------------------------------
// DELETE /v1/webhooks/endpoints/:id
// ---------------------------------------------------------------------

export const deleteWebhookEndpointInputSchema = z.object({ id: z.uuid() }).strict();
export type DeleteWebhookEndpointInput = z.infer<typeof deleteWebhookEndpointInputSchema>;

export const deleteWebhookEndpointOutputSchema = successEnvelope(z.object({ id: z.uuid() }));
export type DeleteWebhookEndpointOutput = z.infer<typeof deleteWebhookEndpointOutputSchema>;

export const deleteWebhookEndpointContract = oc
  .route({ method: 'DELETE', path: '/v1/webhooks/endpoints/{id}' })
  .input(deleteWebhookEndpointInputSchema)
  .output(deleteWebhookEndpointOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/webhooks/endpoints/:id/test - fires one synthetic delivery
// through the SAME sign+dispatch path a real event uses (P15 U5, step 8),
// never a fabricated "ok" response - the id/status returned is the actual
// `webhook_deliveries` row the dispatcher will pick up next tick.
// ---------------------------------------------------------------------

export const testWebhookEndpointInputSchema = z.object({ id: z.uuid() }).strict();
export type TestWebhookEndpointInput = z.infer<typeof testWebhookEndpointInputSchema>;

export const testWebhookEndpointOutputSchema = successEnvelope(
  z.object({
    deliveryId: z.string(),
    status: z.enum(['pending', 'sent', 'failed']),
  }),
);
export type TestWebhookEndpointOutput = z.infer<typeof testWebhookEndpointOutputSchema>;

export const testWebhookEndpointContract = oc
  .route({ method: 'POST', path: '/v1/webhooks/endpoints/{id}/test' })
  .input(testWebhookEndpointInputSchema)
  .output(testWebhookEndpointOutputSchema);

export const webhooksContract = {
  create: createWebhookEndpointContract,
  patch: patchWebhookEndpointContract,
  list: listWebhookEndpointsContract,
  delete: deleteWebhookEndpointContract,
  test: testWebhookEndpointContract,
} as const;
