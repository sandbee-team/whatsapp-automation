import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { eventTypeEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0009_delivery_events.sql` -
 * `delivery_events`. Plain `pgTable` mirror only (same reasoning as
 * `wallet_ledger`/`message_jobs`): Drizzle cannot express
 * `PARTITION BY RANGE (...)`, so the weekly partitioning lives only in the
 * migration / `db/src/partitions.ts`.
 */
export const deliveryEvents = pgTable(
  'delivery_events',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id').notNull(),
    messageJobId: bigint('message_job_id', { mode: 'bigint' }),
    messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }),
    eventType: eventTypeEnum('event_type').notNull(),
    providerEventId: text('provider_event_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    check('de_detail_size', sql`octet_length(${table.detail}::text) <= 250`),
  ],
);
