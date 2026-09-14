import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';

/**
 * Drizzle mirror of `db/migrations/0041_outbox_and_webhooks.sql` -
 * `webhook_deliveries`, the webhook dispatcher's own durable retry state
 * (phase step 7's design). NON-partitioned in v1 - see the migration's own
 * header for the deviation reasoning. One row per (outbox_event_id,
 * endpoint_id) pair, ever - updated in place across retries, never a fresh
 * row per attempt (unlike `send_attempts`). `status` is `text` + CHECK, not
 * a pg enum - same off-ramp `opt_outs.scope`/`pacing_events.kind` already
 * use (`@wp/domain`'s enum manifest is outside this unit's file scope).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').notNull(),
    outboxEventId: bigint('outbox_event_id', { mode: 'bigint' }).notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadHash: bytea('payload_hash').notNull(),
    status: text('status').notNull().default('pending'),
    attempt: smallint('attempt').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    statusCode: smallint('status_code'),
    errorClass: text('error_class'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('webhook_deliveries_outbox_event_id_endpoint_id_key').on(
      table.outboxEventId,
      table.endpointId,
    ),
    check('webhook_deliveries_status_shape', sql`${table.status} IN ('pending', 'sent', 'failed')`),
    check(
      'webhook_deliveries_attempt_ceiling',
      sql`${table.attempt} >= 0 AND ${table.attempt} <= 8`,
    ),
  ],
);
