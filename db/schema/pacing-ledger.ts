import { integer, pgTable, primaryKey, smallint, timestamp, uuid, date } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `pacing_ledger`, THE
 * authoritative counter and THE only grantor (blueprint: "one counter
 * table, one grantor"). `group_sent_count` is the scope-delta group column.
 *
 * PK is `(instance_id, ledger_date)`, NOT client_id-leading - this is the
 * canonical, deliberate shape (the reserve's own conditional-UPDATE/
 * `ON CONFLICT` target), registered in `CANONICAL_AUTHORITY_KEYS`
 * (`db/src/isolation/tenant-tables.ts`), same precedent as `instance_lease_
 * state`/`whatsapp_session_credentials`. Plain `pgTable` mirror only - no
 * `WITH (fillfactor = 70)` here: Drizzle has no storage-parameter API, same
 * "migration owns storage params, mirror owns columns" split as every
 * other fillfactor-tuned table in this schema.
 */
export const pacingLedger = pgTable(
  'pacing_ledger',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    ledgerDate: date('ledger_date').notNull(),
    hourKey: smallint('hour_key').notNull().default(0),
    consumedCount: integer('consumed_count').notNull().default(0),
    sentThisHour: integer('sent_this_hour').notNull().default(0),
    newConvCount: integer('new_conv_count').notNull().default(0),
    systemCount: integer('system_count').notNull().default(0),
    sentOkCount: integer('sent_ok_count').notNull().default(0),
    refundCount: integer('refund_count').notNull().default(0),
    groupSentCount: integer('group_sent_count').notNull().default(0),
    lastReservedAt: timestamp('last_reserved_at', { withTimezone: true }),
    nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.ledgerDate] })],
);
