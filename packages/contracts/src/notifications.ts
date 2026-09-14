import { oc } from '@orpc/contract';
import { z } from 'zod';
import { NOTIFICATION_KINDS, NOTIFICATION_SEVERITIES } from '@wp/domain';
import { successEnvelope } from './envelope.js';

/**
 * notifications.ts (P17 Unit U2, step 2) - contracts for the notifications
 * list/unread-count/mark-read routes. Follows `instances.ts`'s idiom
 * (`.strict()` on every tenant input, `successEnvelope` on every output,
 * enums imported from `@wp/domain` rather than restated).
 *
 * `cursor` is an OPAQUE, server-issued string (keyset pagination:
 * `(createdAt, id)` encoded inside it) - never a client-constructed offset,
 * matching `paginationInputSchema`'s own convention (`envelope.ts`), though
 * this route defines its own input rather than reusing that shared schema
 * because its default `limit` (25) differs from the shared default (20) and
 * it additionally carries `unread`.
 *
 * `payload` on a list row is the notification's minimal ids/enums payload
 * (mirrors the realtime `notification.created` event shape) - never message
 * body/PII, same "go look, never trust the payload for detail" rule as every
 * other real-time-adjacent surface in this codebase.
 */

export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);

// ---------------------------------------------------------------------
// GET /v1/notifications
// ---------------------------------------------------------------------

export const listNotificationsInputSchema = z
  .object({
    /**
     * Coerced from string: Fastify hands `req.query` values as STRINGS
     * (P26b finding c). `unread` uses an explicit `'true'|'false'` enum +
     * transform rather than `z.coerce.boolean()` - that coerces ANY
     * non-empty string (including the literal string `'false'`) to `true`.
     */
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().optional(),
    unread: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();
export type ListNotificationsInput = z.infer<typeof listNotificationsInputSchema>;

export const listNotificationsItemSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  severity: notificationSeveritySchema,
  instanceId: z.uuid().nullable(),
  title: z.string(),
  requiresUserAction: z.boolean(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type ListNotificationsItem = z.infer<typeof listNotificationsItemSchema>;

export const listNotificationsOutputSchema = successEnvelope(
  z.object({
    items: z.array(listNotificationsItemSchema),
    nextCursor: z.string().nullable(),
  }),
);
export type ListNotificationsOutput = z.infer<typeof listNotificationsOutputSchema>;

export const listNotificationsContract = oc
  .route({ method: 'GET', path: '/v1/notifications' })
  .input(listNotificationsInputSchema)
  .output(listNotificationsOutputSchema);

// ---------------------------------------------------------------------
// GET /v1/notifications/unread-count
// ---------------------------------------------------------------------

export const unreadCountOutputSchema = successEnvelope(
  z.object({
    count: z.number().int().nonnegative(),
  }),
);
export type UnreadCountOutput = z.infer<typeof unreadCountOutputSchema>;

export const unreadCountContract = oc
  .route({ method: 'GET', path: '/v1/notifications/unread-count' })
  .output(unreadCountOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/notifications/:id/read
// ---------------------------------------------------------------------

export const markReadOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    readAt: z.iso.datetime(),
  }),
);
export type MarkReadOutput = z.infer<typeof markReadOutputSchema>;

export const markReadContract = oc
  .route({ method: 'POST', path: '/v1/notifications/{id}/read' })
  .output(markReadOutputSchema);

// ---------------------------------------------------------------------
// POST /v1/notifications/read-all
// ---------------------------------------------------------------------

export const markAllReadOutputSchema = successEnvelope(
  z.object({
    updated: z.number().int().nonnegative(),
  }),
);
export type MarkAllReadOutput = z.infer<typeof markAllReadOutputSchema>;

export const markAllReadContract = oc
  .route({ method: 'POST', path: '/v1/notifications/read-all' })
  .output(markAllReadOutputSchema);

export const notificationsContract = {
  list: listNotificationsContract,
  unreadCount: unreadCountContract,
  markRead: markReadContract,
  markAllRead: markAllReadContract,
} as const;
