import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';

/**
 * Postgres `text[]` (`_text` udt) for `events` below - same file-local
 * `customType` trick `outbox-events.ts`'s `textArray` uses (see that file's
 * own comment for why).
 */
const textArray = customType<{ data: string[] }>({
  dataType() {
    return '_text';
  },
});

/**
 * Drizzle mirror of `db/migrations/0041_outbox_and_webhooks.sql` -
 * `webhook_endpoints`, per design SS6.4 plus two columns this migration adds
 * ahead of their consuming phase steps: `include_message_body` (step 8, no
 * API to flip it in v1) and `disabled_reason` (step 7, carries
 * `'consecutive_failures'` when the dispatcher auto-disables at 20).
 * `secret_enc` is envelope-encrypted (bytea), never plaintext.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id').notNull(),
    url: text('url').notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    events: textArray('events').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    includeMessageBody: boolean('include_message_body').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    disabledReason: text('disabled_reason'),
  },
  (table) => [
    check('webhook_endpoints_events_nonempty', sql`cardinality(${table.events}) > 0`),
    check(
      'webhook_endpoints_disabled_reason_shape',
      sql`${table.disabledReason} IS NULL OR ${table.disabledReason} IN ('consecutive_failures', 'manual')`,
    ),
  ],
);
