import type { TenantDb } from '@wp/db';
import type { ListNotificationsItem } from '@wp/contracts';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  type NotificationRow,
} from './notifications.repo.js';

/**
 * notifications.service.ts (P17 U6, step 6) - the thin service layer over
 * `notifications.repo.ts`: maps repo rows to the wire shape
 * (`@wp/contracts`'s `ListNotificationsItem`) and owns nothing else - no
 * additional business rule lives here (dedupe/fanout is `notify()`'s own
 * concern, U3).
 */

function toWireItem(row: NotificationRow): ListNotificationsItem {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    instanceId: row.instanceId,
    title: row.kind,
    requiresUserAction: row.requiresUserAction,
    createdAt: row.createdAt,
    readAt: row.readAt,
    payload: row.payload,
  };
}

export interface ListNotificationsServiceInput {
  clientId: string;
  limit: number;
  cursor?: string;
  unread?: boolean;
}

export interface ListNotificationsServiceResult {
  items: ListNotificationsItem[];
  nextCursor: string | null;
}

export async function listNotificationsForClient(
  tenantDb: TenantDb,
  input: ListNotificationsServiceInput,
): Promise<ListNotificationsServiceResult> {
  const result = await listNotifications(tenantDb, input);
  return { items: result.items.map(toWireItem), nextCursor: result.nextCursor };
}

export async function unreadCountForClient(tenantDb: TenantDb, clientId: string): Promise<number> {
  return countUnread(tenantDb, clientId);
}

export class NotificationNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such notification.');
    this.name = 'NotificationNotFoundError';
  }
}

export interface MarkReadServiceResult {
  id: string;
  readAt: string;
}

export async function markNotificationRead(
  tenantDb: TenantDb,
  input: { clientId: string; id: string; userId: string },
): Promise<MarkReadServiceResult> {
  const result = await markRead(tenantDb, input);
  if (!result) {
    throw new NotificationNotFoundError();
  }
  return result;
}

export async function markAllNotificationsRead(
  tenantDb: TenantDb,
  input: { clientId: string; userId: string },
): Promise<{ updated: number }> {
  const updated = await markAllRead(tenantDb, input);
  return { updated };
}
