import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { contactImports } from './contact-imports.js';

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` -
 * `contact_import_errors`. PK (import_id, row_no) is the ONE canonical
 * suite-A exemption for this table (already present in
 * `SUITE_A_INDEX_EXEMPTIONS`, scope delta) - no CANONICAL_AUTHORITY_KEYS
 * entry needed. `raw_excerpt` is capped at 120 chars and never logged.
 */
export const contactImportErrors = pgTable(
  'contact_import_errors',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => contactImports.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    rowNo: bigint('row_no', { mode: 'bigint' }).notNull(),
    reason: text('reason').notNull(),
    rawExcerpt: text('raw_excerpt'),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.rowNo] }),
    check(
      'contact_import_errors_excerpt_max_120',
      sql`${table.rawExcerpt} IS NULL OR char_length(${table.rawExcerpt}) <= 120`,
    ),
  ],
);
