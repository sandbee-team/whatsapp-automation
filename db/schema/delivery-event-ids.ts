import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Drizzle mirror of `db/migrations/0008_queue_uniqueness_authorities.sql` - `delivery_event_ids`. */
export const deliveryEventIds = pgTable('delivery_event_ids', {
  providerEventId: text('provider_event_id').primaryKey(),
  clientId: uuid('client_id').notNull(),
  messageJobId: bigint('message_job_id', { mode: 'bigint' }),
  messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
