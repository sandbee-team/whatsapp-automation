import { bigint, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { campaigns } from './campaigns.js';

/**
 * Drizzle mirror of `db/migrations/0064_broadcast_recipients_and_counters.sql`
 * - `campaign_counters`, the O(1) progress rollup (one row per campaign,
 * updated once per expansion BATCH - never per recipient row, see that
 * migration's header). Deliberately NO `deferred` column: `deferred` is a
 * derived display bucket computed at read time, never stored (session
 * decision recorded in the scope delta / this phase's canon).
 */
export const campaignCounters = pgTable('campaign_counters', {
  campaignId: uuid('campaign_id')
    .primaryKey()
    .references(() => campaigns.id),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  total: integer('total').notNull().default(0),
  pending: integer('pending').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  queued: integer('queued').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  delivered: integer('delivered').notNull().default(0),
  read: integer('read').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  cancelled: integer('cancelled').notNull().default(0),
  chargedMinor: bigint('charged_minor', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  recomputedAt: timestamp('recomputed_at', { withTimezone: true }),
});
