import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { consentBasisEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0060_contacts_tags_and_imports.sql` -
 * `consent_records`. Created here because P02 never created it (see the
 * migration's own header - never a second consent table). Append-only: no
 * UPDATE/DELETE grant for any app role. One row per import-level attestation
 * (`recipient_e164` NULL), never one row per contact.
 */
export const consentRecords = pgTable('consent_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  recipientE164: text('recipient_e164'),
  basis: consentBasisEnum('basis').notNull(),
  evidenceRef: text('evidence_ref'),
  sourceNote: text('source_note'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  capturedByUserId: uuid('captured_by_user_id'),
});
