import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { users } from './tenancy.js';

/**
 * Drizzle mirror of `db/migrations/0076_api_keys.sql` - `api_keys`. PK
 * `(client_id, id)` already leads with client_id - no CANONICAL_AUTHORITY_KEYS
 * entry needed. `keyPrefix` is the ONLY global (non-tenant-scoped) unique
 * authority on this table (registered in GLOBAL_UNIQUE_INDEXES) - a
 * presenter has no tenant context, so the prefix is the pre-hash lookup
 * handle. `secretHash` is HMAC-SHA256 output (bytea), never bcrypt/argon2 -
 * see the migration header for why. No `scopes` column in v1 (see migration
 * header).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    id: uuid('id').notNull().defaultRandom(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    secretHash: bytea('secret_hash').notNull(),
    last4: text('last4').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.id] }),
    uniqueIndex('api_keys_key_prefix_uq').on(table.keyPrefix),
    index('api_keys_client_created_idx').on(table.clientId, table.createdAt),
    check('api_keys_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 64`),
    check('api_keys_key_prefix_check', sql`${table.keyPrefix} ~ '^wp_live_[0-9a-f]{12}$'`),
    check('api_keys_last4_check', sql`${table.last4} ~ '^[0-9a-f]{4}$'`),
  ],
);
