import { date, integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `content_fingerprints`. PK `(client_id, local_date, fingerprint)` -
 * CLIENT-level (blueprint amendment; the safe-mode design's original
 * instance-level PK is superseded - no `instance_id` column here).
 */
export const contentFingerprints = pgTable(
  'content_fingerprints',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    localDate: date('local_date').notNull(),
    fingerprint: bytea('fingerprint').notNull(),
    recipientCount: integer('recipient_count').notNull().default(0),
    ackBy: uuid('ack_by'),
    ackAt: timestamp('ack_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.localDate, table.fingerprint] })],
);
