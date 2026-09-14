import { bigint, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { msgDirectionEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0008_queue_uniqueness_authorities.sql` -
 * `message_wa_ids`, created in its final both-directions shape (v1 writes
 * `direction = 'out'` rows only - see the migration header). `contentHash`/
 * `observedAt` added by `db/migrations/0026_reconcile_support.sql` (P12 U1)
 * - echo evidence for the reconciler; the migration's
 * `message_wa_ids_message_id_uq` partial unique index and
 * `message_wa_ids_evidence_idx` are not expressed here (this file's existing
 * convention: constraints/indexes live only in the migration, per
 * `db/tests/schema-parity.test.ts`'s column-only comparison, mirroring
 * `send-attempts.ts`'s `UNIQUE(message_job_id, attempt_no)` precedent).
 */
export const messageWaIds = pgTable(
  'message_wa_ids',
  {
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id').notNull(),
    direction: msgDirectionEnum('direction').notNull().default('out'),
    waMsgId: text('wa_msg_id').notNull(),
    messageId: bigint('message_id', { mode: 'bigint' }),
    messageCreatedAt: timestamp('message_created_at', { withTimezone: true }),
    inboxMessageId: bigint('inbox_message_id', { mode: 'bigint' }),
    inboxMessageCreatedAt: timestamp('inbox_message_created_at', { withTimezone: true }),
    contentHash: bytea('content_hash'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.instanceId, table.direction, table.waMsgId] }),
  ],
);
