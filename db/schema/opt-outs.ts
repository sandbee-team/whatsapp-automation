import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0036_optout_and_content_guards.sql` -
 * `opt_outs`, per safe-mode design SS6.2. `scope`/`scope_key` let one table
 * serve both client-level and instance-level opt-outs without a nullable-
 * FK-pair shape. The partial unique index `opt_outs_lookup` is the
 * "currently opted out" lookup authority (`WHERE restored_at IS NULL`) - a
 * restore frees the slot for a fresh opt-out row, preserving full history.
 * No DELETE grant for any app role (see migration header): an opt-out row
 * outlives the contact; restore is an UPDATE, never a DELETE.
 */
export const optOuts = pgTable(
  'opt_outs',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    scope: text('scope').notNull(),
    scopeKey: uuid('scope_key').notNull(),
    phoneHash: bytea('phone_hash').notNull(),
    phoneEnc: bytea('phone_enc').notNull(),
    source: text('source').notNull(),
    matchedKeyword: text('matched_keyword'),
    originInstanceId: uuid('origin_instance_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    restoredBy: uuid('restored_by'),
    restoreReason: text('restore_reason'),
  },
  (table) => [
    check('opt_outs_scope_check', sql`${table.scope} IN ('client', 'instance')`),
    uniqueIndex('opt_outs_lookup')
      .on(table.clientId, table.scopeKey, table.phoneHash)
      .where(sql`${table.restoredAt} IS NULL`),
  ],
);
