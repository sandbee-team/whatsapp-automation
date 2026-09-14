import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';
import { broadcastStatusEnum, jobPriorityEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0010_claim_join_shells.sql` (CREATE) +
 * `db/migrations/0064_broadcast_recipients_and_counters.sql` (ALTER, P23
 * Unit U1) - `campaigns`, the broadcast lifecycle row. `status` was created
 * by 0010; every other column below (including `instance_id`/`name`/
 * `created_by_user_id`/`idempotency_key`, this phase's gap-filling additions
 * to the scope delta's DDL) is added by 0064 - this file mirrors the FULL
 * post-0064 column set, not the 0010 shell alone.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    status: broadcastStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // migration 0064 (P23 U1) additions below.
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    name: text('name').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    idempotencyKey: text('idempotency_key'),
    audience: jsonb('audience').notNull(),
    message: jsonb('message').notNull(),
    targetKind: text('target_kind').notNull().default('contacts'),
    priority: jobPriorityEnum('priority').notNull().default('low'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    snapshotCursorContactId: uuid('snapshot_cursor_contact_id'),
    snapshotDoneAt: timestamp('snapshot_done_at', { withTimezone: true }),
    expandCursorRecipientId: bigint('expand_cursor_recipient_id', { mode: 'number' })
      .notNull()
      .default(0),
    expandDoneAt: timestamp('expand_done_at', { withTimezone: true }),
    audienceCount: integer('audience_count'),
    priceKey: text('price_key'),
    quoteMinor: bigint('quote_minor', { mode: 'number' }),
    pausedByUserId: uuid('paused_by_user_id'),
    cancelReason: text('cancel_reason'),
  },
  (table) => [
    check('campaigns_target_kind_check', sql`${table.targetKind} IN ('contacts', 'groups')`),
    uniqueIndex('campaigns_client_idem_uq')
      .on(table.clientId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    // Mirrors migration 0065 (P23a C1 fix Unit F1) - the 5s active funnel
    // sweep's keyset rotation (`status IN (...) AND id > $cursor ORDER BY
    // id`). Migration 0064's campaigns_worker_discovery_idx is partial on
    // ('snapshotting', 'expanding') only and cannot serve 'running'/'paused'.
    index('campaigns_funnel_discovery_idx')
      .on(table.id)
      .where(sql`status IN ('snapshotting', 'expanding', 'running', 'paused')`),
  ],
);
