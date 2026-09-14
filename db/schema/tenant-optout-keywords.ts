import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `tenant_optout_keywords`, additive-only relative to the platform opt-out
 * keyword list (the platform list lives in `@wp/domain` CODE, never as rows
 * here - no grant on this table can ever delete a platform entry). wp_app
 * may INSERT/SELECT/DELETE its own rows under RLS; there is no UPDATE
 * surface (a keyword is either present or absent).
 */
export const tenantOptoutKeywords = pgTable(
  'tenant_optout_keywords',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    keyword: text('keyword').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.keyword] })],
);
