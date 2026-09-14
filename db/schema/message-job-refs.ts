import { sql } from 'drizzle-orm';
import { bigint, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';

/**
 * Drizzle mirror of `db/migrations/0008_queue_uniqueness_authorities.sql` -
 * `message_job_refs`, plus `request_hash` from migration 0024 (P11).
 */
export const messageJobRefs = pgTable(
  'message_job_refs',
  {
    publicId: uuid('public_id').primaryKey(),
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id').notNull(),
    messageJobId: bigint('message_job_id', { mode: 'bigint' }).notNull(),
    messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key'),
    dedupeKey: text('dedupe_key'),
    /** Migration 0024 (P11): SHA-256 of the canonicalised request body, so an
     * idempotency-key conflict can tell a genuine replay from key REUSE with a
     * different body (`409 IDEMPOTENCY_KEY_REUSED`). Nullable - see 0024's header. */
    requestHash: bytea('request_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mjr_idem_uq')
      .on(table.clientId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    uniqueIndex('mjr_dedupe_uq')
      .on(table.clientId, table.instanceId, table.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  ],
);
