import { sql } from 'drizzle-orm';
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { consentBasisEnum, contactOptOutStateEnum, contactSourceEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` -
 * `contacts`, the tenant's address book. `opt_out_state` is a MIRROR ONLY,
 * never the gate - the authority is `opt_outs` (migration 0036); this column
 * is written exclusively by `optout-mirror.ts` (a later P20 unit) inside the
 * same transaction as the `opt_outs` insert/restore.
 *
 * `contacts_client_phone_uq` is PARTIAL (`WHERE deleted_at IS NULL`) - every
 * upsert against it must repeat that predicate in its `ON CONFLICT` clause.
 *
 * `contacts_client_id_id_key` (migration 0061, P20 C2 fix) is a plain
 * (non-partial) UNIQUE on (client_id, id), redundant with the surrogate `id`
 * PK for uniqueness - it exists only so `contact_tag_links`' composite FK
 * has a matching unique target, making a cross-tenant tag/contact link
 * impossible at the storage layer.
 *
 * `last_import_id` (migration 0062, P20 C1 round-3 fix) is the import that
 * most recently inserted/updated this row - unlike `import_id` (the import
 * that CREATED it, never overwritten), this column IS overwritten by every
 * upsert, giving the cross-batch dedupe check exact provenance instead of an
 * `updated_at` time heuristic.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    phoneE164: text('phone_e164').notNull(),
    phoneHash: bytea('phone_hash').notNull(),
    waJid: text('wa_jid').notNull(),
    addressingMode: text('addressing_mode').notNull().default('pn'),
    lidJid: text('lid_jid'),
    displayName: text('display_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    attrs: jsonb('attrs').notNull().default({}),
    source: contactSourceEnum('source').notNull(),
    consentBasis: consentBasisEnum('consent_basis'),
    importId: uuid('import_id'),
    lastImportId: uuid('last_import_id'),
    optOutState: contactOptOutStateEnum('opt_out_state').notNull().default('none'),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('contacts_addressing_mode_check', sql`${table.addressingMode} IN ('pn', 'lid')`),
    check('contacts_attrs_max_2048', sql`octet_length(${table.attrs}::text) <= 2048`),
    uniqueIndex('contacts_client_phone_uq')
      .on(table.clientId, table.phoneE164)
      .where(sql`${table.deletedAt} IS NULL`),
    unique('contacts_client_id_id_key').on(table.clientId, table.id),
  ],
);
