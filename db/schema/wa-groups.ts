import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0066_groups.sql` - `wa_groups`. COUNTS
 * ONLY, FOREVER (ADR 0017 SS2): `participantCount`/`trackedParticipantDevices`
 * are ints; this table must never grow a participant/member/admin-list
 * column of any kind, no jsonb, no array, no bytea - see the migration's own
 * header for the full reasoning. `id` is app-visible but DB-defaulted
 * (`gen_random_uuid()`), same class as `contacts.id`/`topupRequests.id` -
 * rows are discovered by the session worker's group sync, never
 * client-supplied.
 */
export const waGroups = pgTable(
  'wa_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    groupJid: text('group_jid').notNull(),
    subject: text('subject'),
    participantCount: integer('participant_count'),
    isAnnounce: boolean('is_announce').notNull().default(false),
    ourRole: text('our_role'),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    sendEnabled: boolean('send_enabled').notNull().default(false),
    sendEnabledAt: timestamp('send_enabled_at', { withTimezone: true }),
    sendEnabledByUserId: uuid('send_enabled_by_user_id'),
    disabledReason: text('disabled_reason'),
    trackedParticipantDevices: integer('tracked_participant_devices').notNull().default(0),
    nextSyncAfter: timestamp('next_sync_after', { withTimezone: true }),
    leaveRequestedAt: timestamp('leave_requested_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('wa_groups_client_instance_jid_uq').on(table.clientId, table.instanceId, table.groupJid),
    check('wa_groups_jid_shape', sql`${table.groupJid} LIKE '%@g.us'`),
    check(
      'wa_groups_counts_nonneg',
      sql`coalesce(${table.participantCount}, 0) >= 0 AND ${table.trackedParticipantDevices} >= 0`,
    ),
    check('wa_groups_our_role_check', sql`${table.ourRole} IN ('member', 'admin', 'superadmin')`),
    index('wa_groups_send_enabled_idx').on(table.clientId, table.instanceId, table.sendEnabled),
    index('wa_groups_pending_idx')
      .on(table.instanceId)
      .where(
        sql`${table.leaveRequestedAt} IS NOT NULL AND ${table.leftAt} IS NULL OR ${table.nextSyncAfter} IS NOT NULL`,
      ),
  ],
);
