import { date, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `content_fingerprint_recipients`, the per-recipient half of the content-
 * fingerprint dedupe/fan-out surface. PK `(client_id, local_date,
 * fingerprint, recipient_hash)`.
 */
export const contentFingerprintRecipients = pgTable(
  'content_fingerprint_recipients',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    localDate: date('local_date').notNull(),
    fingerprint: bytea('fingerprint').notNull(),
    recipientHash: bytea('recipient_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.clientId, table.localDate, table.fingerprint, table.recipientHash],
    }),
  ],
);
