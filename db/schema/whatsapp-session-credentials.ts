import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0020_session_auth_state.sql` -
 * `whatsapp_session_credentials`. One row per instance: the full serialized
 * Baileys creds blob, envelope-encrypted (ciphertext/iv/auth_tag sealed
 * under a per-row DEK, itself wrapped by a KEK).
 */
export const whatsappSessionCredentials = pgTable('whatsapp_session_credentials', {
  instanceId: uuid('instance_id')
    .primaryKey()
    .references(() => whatsappInstances.id),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  authTag: bytea('auth_tag').notNull(),
  dekWrapped: bytea('dek_wrapped').notNull(),
  dekIv: bytea('dek_iv').notNull(),
  dekTag: bytea('dek_tag').notNull(),
  kekId: text('kek_id').notNull(),
  encVersion: integer('enc_version').notNull(),
  sessionEpoch: integer('session_epoch').notNull().default(0),
  credVersion: bigint('cred_version', { mode: 'bigint' }).notNull(),
  ownerFence: bigint('owner_fence', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});
