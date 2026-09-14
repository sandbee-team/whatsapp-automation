import { foreignKey, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { contactTags } from './contact-tags.js';
import { contacts } from './contacts.js';

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` +
 * `0061_contact_tag_links_composite_tenant_fks.sql` - `contact_tag_links`,
 * the tag <-> contact join. PK (client_id, tag_id, contact_id) already leads
 * with client_id - no CANONICAL_AUTHORITY_KEYS entry needed.
 *
 * `tagId`/`contactId` are plain `uuid` columns (no single-column
 * `.references()`) because migration 0061 replaced their single-column FKs
 * with the two composite `foreignKey(...)` below, each keyed on
 * (client_id, tag_id|contact_id) against `contact_tags`/`contacts`'
 * (client_id, id) unique constraints - a row can no longer reference
 * another tenant's tag or contact (core invariant 4 / P20 C2 fix).
 */
export const contactTagLinks = pgTable(
  'contact_tag_links',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    tagId: uuid('tag_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.tagId, table.contactId] }),
    foreignKey({
      name: 'contact_tag_links_tag_tenant_fkey',
      columns: [table.clientId, table.tagId],
      foreignColumns: [contactTags.clientId, contactTags.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'contact_tag_links_contact_tenant_fkey',
      columns: [table.clientId, table.contactId],
      foreignColumns: [contacts.clientId, contacts.id],
    }),
  ],
);
