import type { z } from 'zod';
import {
  listNotificationsOutputSchema,
  unreadCountOutputSchema,
  markReadOutputSchema,
  markAllReadOutputSchema,
} from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/notifications/api.ts (P17 U5) - the client side of
 * `notificationsContract` (`list`/`unreadCount`/`markRead`/`markAllRead`).
 * Every response type is inferred FROM the imported `@wp/contracts` schemas
 * (never hand-typed), same idiom as `features/instances/api.ts`.
 *
 * `listNotifications`'s `cursor` is the OPAQUE, server-issued string the
 * contract itself documents (keyset pagination) - callers pass back exactly
 * what the previous page's `nextCursor` returned, never an offset/page
 * number they construct themselves.
 */

export type ListNotificationsResult = z.infer<typeof listNotificationsOutputSchema>['data'];
export type NotificationItem = ListNotificationsResult['items'][number];

export type UnreadCountResult = z.infer<typeof unreadCountOutputSchema>['data'];

export type MarkReadResult = z.infer<typeof markReadOutputSchema>['data'];

export type MarkAllReadResult = z.infer<typeof markAllReadOutputSchema>['data'];

export interface ListNotificationsParams {
  cursor?: string;
  unread?: boolean;
  limit?: number;
}

export function listNotifications(
  params: ListNotificationsParams = {},
): Promise<ListNotificationsResult> {
  const searchParams = new URLSearchParams();
  if (params.cursor !== undefined) searchParams.set('cursor', params.cursor);
  if (params.unread !== undefined) searchParams.set('unread', String(params.unread));
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  const query = searchParams.toString();
  const path = query.length > 0 ? `/v1/notifications?${query}` : '/v1/notifications';
  return apiFetch<ListNotificationsResult>(path);
}

export function fetchUnreadCount(): Promise<UnreadCountResult> {
  return apiFetch<UnreadCountResult>('/v1/notifications/unread-count');
}

export function markNotificationRead(id: string): Promise<MarkReadResult> {
  return apiFetch<MarkReadResult>(`/v1/notifications/${id}/read`, { method: 'POST' });
}

export function markAllNotificationsRead(): Promise<MarkAllReadResult> {
  return apiFetch<MarkAllReadResult>('/v1/notifications/read-all', { method: 'POST' });
}
