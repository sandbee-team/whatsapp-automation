import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, citext } from './custom-types.js';
import { staffRoleEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0070_admin_staff_audit_impersonation_and_
 * plans.sql` - `staff_users`. Non-tenant (no client_id) - staff belong to
 * WP, not to a client. `mfaTotpSecretEnc` is envelope-encrypted (bytea,
 * purpose user-secrets), never plaintext, same discipline as
 * `users.mfaTotpSecretEnc` (`./tenancy.ts`). `tokenEpoch` is
 * bigint/`mode: 'bigint'` - Postgres is the session-invalidation authority,
 * Redis is only a cache, same pattern as `users.tokenEpoch`.
 */
export const staffUsers = pgTable('staff_users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(), // argon2id
  role: staffRoleEnum('role').notNull(),
  status: text('status').notNull().default('active'),
  mfaTotpSecretEnc: bytea('mfa_totp_secret_enc'),
  mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
  tokenEpoch: bigint('token_epoch', { mode: 'bigint' }).notNull().default(0n),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
