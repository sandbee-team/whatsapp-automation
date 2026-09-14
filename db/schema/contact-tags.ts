import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { citext } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` -
 * `contact_tags`. `contact_count` is maintained in the same transaction as
 * the `contact_tag_links` write (P20 step 4), never recomputed lazily.
 *
 * `contact_tags_client_id_id_key` (migration 0061, P20 C2 fix) is a UNIQUE
 * on (client_id, id), redundant with the surrogate `id` PK for uniqueness -
 * it exists only so `contact_tag_links`' composite FK has a matching unique
 * target, making a cross-tenant tag link impossible at the storage layer.
 */
export const contactTags = pgTable(
  'contact_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    name: citext('name').notNull(),
    color: text('color'),
    contactCount: integer('contact_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('contact_tags_client_id_name_key').on(table.clientId, table.name),
    unique('contact_tags_client_id_id_key').on(table.clientId, table.id),
  ],
);
