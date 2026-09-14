import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { users } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0077_media_assets.sql` - `media_assets`
 * (P34 U-upload, ADR 0052 accepted scope). PK `(client_id, id)` already
 * leads with client_id - no CANONICAL_AUTHORITY_KEYS entry needed. `kind`
 * is restricted to `'image' | 'document'` by the migration's CHECK - the
 * accepted slice only; widening needs a follow-up migration. Unique
 * `(client_id, sha256)` is the dedupe authority (ADR 0052 accepted item 2).
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    id: uuid('id').notNull().defaultRandom(),
    kind: text('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    fileName: text('file_name'),
    storageKey: text('storage_key').notNull(),
    sha256: bytea('sha256').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.id] }),
    uniqueIndex('media_assets_client_sha256_uq').on(table.clientId, table.sha256),
    index('media_assets_retention_idx').on(table.clientId, table.lastUsedAt, table.createdAt),
    check('media_assets_kind_check', sql`${table.kind} IN ('image', 'document')`),
    check('media_assets_size_bytes_check', sql`${table.sizeBytes} > 0`),
  ],
);
