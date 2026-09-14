import { bigint, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0020_session_auth_state.sql` -
 * `whatsapp_session_keys`. One row per (instance, key_type, key_id) durable
 * Signal key (the three `DURABLE_KEY_TYPES` from `@wp/domain` only - the
 * migration's CHECK constraint is the enforcement point; Drizzle mirrors
 * compare columns only, per `db/tests/schema-parity.test.ts`).
 */
export const whatsappSessionKeys = pgTable(
  'whatsapp_session_keys',
  {
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    keyType: text('key_type').notNull(),
    keyId: text('key_id').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    dekWrapped: bytea('dek_wrapped').notNull(),
    dekIv: bytea('dek_iv').notNull(),
    dekTag: bytea('dek_tag').notNull(),
    kekId: text('kek_id').notNull(),
    encVersion: integer('enc_version').notNull(),
    ownerFence: bigint('owner_fence', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.keyType, table.keyId] })],
);
