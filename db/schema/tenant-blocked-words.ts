import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `tenant_blocked_words`, additive-only relative to the platform blocked-
 * word list (the platform list lives in `@wp/domain` CODE, never as rows
 * here). Same shape/grant story as `tenant_optout_keywords` - see that
 * file's header.
 */
export const tenantBlockedWords = pgTable(
  'tenant_blocked_words',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    word: text('word').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.word] })],
);
