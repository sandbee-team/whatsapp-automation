import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `instance_recipient_contacts`, the single source of `is_new_conversation`/
 * `first_inbound_at`. Did NOT exist before migration 0036 (phase-file
 * prerequisite escape hatch - created there, see that migration's header).
 * PK `(client_id, instance_id, recipient_hash)`.
 */
export const instanceRecipientContacts = pgTable(
  'instance_recipient_contacts',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    recipientHash: bytea('recipient_hash').notNull(),
    firstOutboundAt: timestamp('first_outbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    firstInboundAt: timestamp('first_inbound_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.instanceId, table.recipientHash] })],
);
