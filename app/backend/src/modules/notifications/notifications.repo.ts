import type { TenantDb } from '@wp/db';
import type { NotificationKind, NotificationSeverity } from '@wp/domain';

/**
 * notifications.repo.ts (P17 U6, step 6) - the in-app API's own read/write
 * surface over `notifications` (migration 0048). KEYSET ONLY (canon,
 * `packages/contracts/src/notifications.ts`'s own doc comment): every list
 * statement below orders `(created_at DESC, id DESC)` and filters with a
 * `(created_at, id) < (cursor_created_at, cursor_id)` row-comparison
 * predicate - there is NO `OFFSET` anywhere in this file
 * (`scripts/check-sql-lint.ts`'s own no-OFFSET rule would fail the build if
 * one appeared). `unread=true` reuses `notifications_unread_idx` (the
 * partial `WHERE read_at IS NULL` index); the plain list reuses
 * `notifications_list_idx` (migration 0048's own header explains why two
 * indexes are needed instead of one).
 *
 * CURSOR ENCODING: opaque to the client (canon) - base64 of
 * `${createdAtIso}|${id}`, decoded here and NOWHERE else. A malformed cursor
 * is a typed `InvalidCursorError`, mapped by the route to `VALIDATION_ERROR`
 * - never a raw SQL error from a mis-shaped bind.
 *
 * TENANT SCOPE: every statement is client_id-bound AND runs inside
 * `tenantDb.withTenant(clientId, ...)` (RLS FORCE, migration 0048) - the
 * session's own `clientId` is the only source of tenant scope (this module
 * never accepts a caller-supplied client id).
 */

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  instanceId: string | null;
  requiresUserAction: boolean;
  createdAt: string;
  readAt: string | null;
  payload: Record<string, unknown>;
}

export class InvalidCursorError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor() {
    super('Invalid pagination cursor.');
    this.name = 'InvalidCursorError';
  }
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

/** Encodes an opaque, server-issued cursor from the LAST row of a page - never a client-constructed offset. */
export function encodeCursor(input: DecodedCursor): string {
  return Buffer.from(`${input.createdAt}|${input.id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor previously produced by `encodeCursor` - throws `InvalidCursorError` on any malformed input. */
export function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  const sepIndex = decoded.indexOf('|');
  if (sepIndex <= 0 || sepIndex === decoded.length - 1) {
    throw new InvalidCursorError();
  }
  const createdAt = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidCursorError();
  }
  return { createdAt, id };
}

interface NotificationRawRow extends Record<string, unknown> {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  instance_id: string | null;
  requires_user_action: boolean;
  created_at: Date;
  read_at: Date | null;
  payload: Record<string, unknown>;
}

function mapRow(row: NotificationRawRow): NotificationRow {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    instanceId: row.instance_id,
    requiresUserAction: row.requires_user_action,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at ? row.read_at.toISOString() : null,
    payload: row.payload,
  };
}

export interface ListNotificationsRepoInput {
  clientId: string;
  limit: number;
  cursor?: string;
  unread?: boolean;
}

export interface ListNotificationsRepoResult {
  items: NotificationRow[];
  nextCursor: string | null;
}

/** One extra row fetched beyond `limit` - present iff there is a next page (never a second COUNT query). */
async function runList(
  tenantDb: TenantDb,
  input: ListNotificationsRepoInput,
): Promise<ListNotificationsRepoResult> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  const unreadOnly = input.unread === true;

  const rows = await tenantDb.withTenant(input.clientId, async (tx) => {
    // The tenant predicate lives in the SQL literal (not a joined condition
    // array) so check-tenant-scope can see it statically; it is structurally
    // always present regardless of the optional filters below.
    const conditions: string[] = [];
    const params: unknown[] = [input.clientId];

    if (unreadOnly) {
      conditions.push('read_at IS NULL');
    }
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(input.limit + 1);
    const extraConditions = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id, kind, severity, instance_id, requires_user_action, created_at, read_at, payload
                   FROM notifications
                  WHERE client_id = $1${extraConditions}
                  ORDER BY created_at DESC, id DESC
                  LIMIT $${params.length}`;
    const result = await tx.query<NotificationRawRow>(sql, params);
    return result.rows;
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items = page.map(mapRow);
  const last = items.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}

export async function listNotifications(
  tenantDb: TenantDb,
  input: ListNotificationsRepoInput,
): Promise<ListNotificationsRepoResult> {
  return runList(tenantDb, input);
}

/** Reuses `notifications_unread_idx` (partial, `read_at IS NULL`) - a single scalar count, never a whole-table scan. */
export async function countUnread(tenantDb: TenantDb, clientId: string): Promise<number> {
  const result = await tenantDb.withTenant(clientId, (tx) =>
    tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications WHERE client_id = $1 AND read_at IS NULL`,
      [clientId],
    ),
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface MarkReadResult {
  id: string;
  readAt: string;
}

/** Idempotent: sets `read_at`/`read_by_user_id` only if currently unread. A repeat call on an already-read row returns the ORIGINAL `read_at` (never overwrites it with a new timestamp). */
export async function markRead(
  tenantDb: TenantDb,
  input: { clientId: string; id: string; userId: string },
): Promise<MarkReadResult | undefined> {
  return tenantDb.withTenant(input.clientId, async (tx) => {
    const updated = await tx.query<{ id: string; read_at: Date }>(
      `UPDATE notifications SET read_at = now(), read_by_user_id = $3
        WHERE id = $1 AND client_id = $2 AND read_at IS NULL
      RETURNING id, read_at`,
      [input.id, input.clientId, input.userId],
    );
    if (updated.rows[0]) {
      return { id: updated.rows[0].id, readAt: updated.rows[0].read_at.toISOString() };
    }
    // Idempotent no-op path: already read (or no such row) - read back the
    // existing row's own read_at rather than treating a repeat call as an
    // error. A genuinely missing row resolves to undefined (the route maps
    // that to NOT_FOUND).
    const existing = await tx.query<{ id: string; read_at: Date | null }>(
      `SELECT id, read_at FROM notifications WHERE id = $1 AND client_id = $2`,
      [input.id, input.clientId],
    );
    const row = existing.rows[0];
    if (!row) return undefined;
    return { id: row.id, readAt: (row.read_at ?? new Date()).toISOString() };
  });
}

/** Bounded UPDATE - only currently-unread rows for this tenant. Returns the number of rows actually flipped. */
export async function markAllRead(
  tenantDb: TenantDb,
  input: { clientId: string; userId: string },
): Promise<number> {
  const result = await tenantDb.withTenant(input.clientId, (tx) =>
    tx.query(
      `UPDATE notifications SET read_at = now(), read_by_user_id = $2
        WHERE client_id = $1 AND read_at IS NULL`,
      [input.clientId, input.userId],
    ),
  );
  return result.rowCount ?? 0;
}
