import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `optout_confirmations`. PK `(client_id, scope_key, phone_hash)`. NO FK to
 * `opt_outs` (deliberate - migration header binding decision 4): this row
 * must survive a restore/re-opt-out cycle so the 30-day confirmation rule
 * cannot be reset by opting out again.
 */
export const optoutConfirmations = pgTable(
  'optout_confirmations',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    scopeKey: uuid('scope_key').notNull(),
    phoneHash: bytea('phone_hash').notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.scopeKey, table.phoneHash] })],
);
