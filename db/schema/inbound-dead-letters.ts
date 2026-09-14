import { bigint, check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0063_inbound_dead_letters.sql` -
 * `inbound_dead_letters`, the headless inbound listener's dead-letter row
 * (P21). Bounded, non-partitioned; ids and hashes only - never a body,
 * `payload`, `snippet` or `preview`. `id` is a bigint identity surrogate row
 * handle only (CANONICAL_AUTHORITY_KEYS, same class as `outbox_events`).
 */
export const inboundDeadLetters = pgTable(
  'inbound_dead_letters',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    waMsgId: text('wa_msg_id'),
    chatJidHash: bytea('chat_jid_hash'),
    errorClass: text('error_class').notNull(),
    rawSize: integer('raw_size'),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'inbound_dead_letters_raw_size_non_negative',
      sql`${table.rawSize} IS NULL OR ${table.rawSize} >= 0`,
    ),
  ],
);
