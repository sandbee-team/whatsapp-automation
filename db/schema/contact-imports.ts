import {
  bigint,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bpchar2 } from './custom-types.js';
import { clients } from './tenancy.js';
import { contactImportStatusEnum } from './enums.js';

/**
 * Postgres `uuid[]` (`_uuid` udt) for `apply_tag_ids` below - same file-local
 * `customType` trick `pacing-events.ts`'s/`outbox-events.ts`'s `textArray`
 * already established (drizzle-orm's built-in `.array()` reports
 * `getSQLType() === 'uuid[]'`, which does not match
 * `information_schema.columns.udt_name`'s `'_uuid'` for a real array column).
 */
const uuidArray = customType<{ data: string[] }>({
  dataType() {
    return '_uuid';
  },
});

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` -
 * `contact_imports`, the resumable CSV import job. Status may not leave
 * `uploaded` without `attestation_text`/`attested_by_user_id`/`attested_at`
 * all being set (enforced at the application layer, P20 step 5) - all three
 * are NOT NULL here because the row is only ever insertable with them.
 */
export const contactImports = pgTable('contact_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  filename: text('filename'),
  storageKey: text('storage_key').notNull(),
  mapping: jsonb('mapping').notNull(),
  defaultCountry: bpchar2('default_country').notNull(),
  applyTagIds: uuidArray('apply_tag_ids').notNull().default([]),
  attestationText: text('attestation_text').notNull(),
  attestedByUserId: uuid('attested_by_user_id').notNull(),
  attestedAt: timestamp('attested_at', { withTimezone: true }).notNull(),
  status: contactImportStatusEnum('status').notNull().default('uploaded'),
  cursorRow: bigint('cursor_row', { mode: 'bigint' }).notNull().default(0n),
  totalRows: integer('total_rows'),
  importedCount: integer('imported_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  invalidCount: integer('invalid_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  optedOutCount: integer('opted_out_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
