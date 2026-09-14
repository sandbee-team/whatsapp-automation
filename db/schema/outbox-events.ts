import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Postgres `text[]` (`_text` udt) for `fanout` below - same file-local
 * `customType` trick `pacing-events.ts`'s `textArray` already established
 * (drizzle-orm's built-in `.array()` reports `getSQLType() === 'text[]'`,
 * which does not match `information_schema.columns.udt_name`'s `'_text'`
 * for a real array column; `db/tests/schema-parity.test.ts` is outside this
 * unit's file scope to extend with a mapping entry).
 */
const textArray = customType<{ data: string[] }>({
  dataType() {
    return '_text';
  },
});

/**
 * Drizzle mirror of `db/migrations/0041_outbox_and_webhooks.sql` -
 * `outbox_events`, the fan-out work queue (P15 outbox-relay-and-webhooks).
 * Non-partitioned by design: drained and deleted by the relay, never a
 * history table (see the migration's own header). `fanout` is a subset of
 * `{sse, webhook}`; an SSE-fanned row without a `coalesce_key` is rejected
 * at the storage layer (`outbox_events_sse_requires_coalesce_key`).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id'),
    eventType: text('event_type').notNull(),
    entityId: text('entity_id').notNull(),
    payload: jsonb('payload').notNull(),
    coalesceKey: text('coalesce_key'),
    fanout: textArray('fanout').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    suppressedBy: bigint('suppressed_by', { mode: 'bigint' }),
    attempts: smallint('attempts').notNull().default(0),
  },
  (table) => [
    check('outbox_events_payload_size', sql`pg_column_size(${table.payload}) <= 1024`),
    check('outbox_events_fanout_subset', sql`${table.fanout} <@ ARRAY['sse', 'webhook']::text[]`),
    check('outbox_events_fanout_nonempty', sql`cardinality(${table.fanout}) > 0`),
    check(
      'outbox_events_sse_requires_coalesce_key',
      sql`'sse' <> ALL(${table.fanout}) OR ${table.coalesceKey} IS NOT NULL`,
    ),
  ],
);
