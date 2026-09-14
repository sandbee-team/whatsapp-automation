import { date, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` - `client_daily_usage`,
 * the plan-level daily-send cap counter, enforced by the same conditional-
 * UPDATE reserve mechanism as `pacing_ledger`, just rolled up per client.
 * PK `(client_id, ledger_date)` already leads with `client_id` - no
 * `CANONICAL_AUTHORITY_KEYS` entry needed.
 */
export const clientDailyUsage = pgTable(
  'client_daily_usage',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    ledgerDate: date('ledger_date').notNull(),
    sentCount: integer('sent_count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.ledgerDate] })],
);
