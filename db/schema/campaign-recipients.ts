import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { campaigns } from './campaigns.js';
import { contacts } from './contacts.js';
import { broadcastRecipientStatusEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0064_broadcast_recipients_and_counters.sql`
 * - `campaign_recipients`, the FROZEN audience snapshot. Deliberately NOT
 * partitioned: it is a uniqueness authority (`cr_campaign_target_uq`), the
 * fourth `SUITE_A_INDEX_EXEMPTIONS` entry (registered ahead of this
 * migration by the P03/P07 dispatch text) - its unique index legitimately
 * does not lead with `client_id`. `group_id` carries no FK yet (groups is
 * P24).
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    groupId: uuid('group_id'), // NO FK yet: groups is P24
    recipientJid: text('recipient_jid').notNull(),
    recipientE164: text('recipient_e164'),
    recipientHash: bytea('recipient_hash').notNull(),
    vars: jsonb('vars').notNull().default({}),
    status: broadcastRecipientStatusEnum('status').notNull().default('pending'),
    messageJobPublicId: uuid('message_job_public_id'),
    skipReason: text('skip_reason'),
    failureClass: text('failure_class'),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    chargedMinor: bigint('charged_minor', { mode: 'number' }),
  },
  (table) => [
    check('cr_exactly_one_target', sql`(${table.contactId} IS NULL) <> (${table.groupId} IS NULL)`),
    uniqueIndex('cr_campaign_target_uq').on(
      table.campaignId,
      sql`coalesce(${table.contactId}, ${table.groupId})`,
    ),
  ],
);
