import { bigint, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { attemptStateEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0008_queue_uniqueness_authorities.sql` -
 * `send_attempts`. NOT partitioned (small, retention by DELETE), so its
 * `UNIQUE (message_job_id, attempt_no)` constraint is a real global
 * constraint - Drizzle's `unique()` table builder is not used here (schema
 * mirrors only compare columns per `db/tests/schema-parity.test.ts`; the
 * migration is authoritative for constraints).
 */
export const sendAttempts = pgTable('send_attempts', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  clientId: uuid('client_id').notNull(),
  instanceId: uuid('instance_id').notNull(),
  messageJobId: bigint('message_job_id', { mode: 'bigint' }).notNull(),
  messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }).notNull(),
  leaseId: uuid('lease_id'),
  ownerFence: bigint('owner_fence', { mode: 'bigint' }),
  attemptNo: smallint('attempt_no').notNull(),
  contentHash: bytea('content_hash'),
  clientMsgId: text('client_msg_id'),
  state: attemptStateEnum('state').notNull().default('prepared'),
  providerMsgId: text('provider_msg_id'),
  errorClass: text('error_class'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
