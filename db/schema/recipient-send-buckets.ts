import { integer, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `recipient_send_buckets`, TRUE rolling-hour send-frequency counters.
 * Supersedes the safe-mode design's daily-count `recipient_frequency` table
 * (not created). PK `(client_id, phone_hash, hour_bucket)`.
 *
 * `hour_bucket` CONTRACT (binding, normative for later units):
 * `hour_bucket = date_trunc('hour', <send time>)`, written by the
 * send-result transaction - never derived any other way.
 */
export const recipientSendBuckets = pgTable(
  'recipient_send_buckets',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    phoneHash: bytea('phone_hash').notNull(),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.phoneHash, table.hourBucket] })],
);
