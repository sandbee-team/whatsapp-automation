import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, inet } from './custom-types.js';
import { users } from './tenancy.js';

/**
 * Drizzle mirrors of `db/migrations/0013_auth_and_onboarding.sql` - the
 * three user-keyed auth tables. No `client_id` anywhere here: identity is
 * global, the same class as `users` itself (see
 * `db/src/isolation/tenant-tables.ts`'s `ISOLATION_NON_TENANT_TABLES`).
 * `authSessions.parentSessionId` is a self-reference, deliberately declared
 * as a plain nullable `uuid` (no `.references()`) rather than fighting
 * Drizzle's `AnyPgColumn` self-FK typing - `db/tests/schema-parity.test.ts`
 * only compares columns/types/nullability, never FK targets, so the
 * migration stays the sole authority for that constraint.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    refreshTokenHash: bytea('refresh_token_hash').notNull().unique(),
    parentSessionId: uuid('parent_session_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ip: inet('ip'),
    userAgentHash: bytea('user_agent_hash'), // hash, never the raw UA
    deviceLabel: text('device_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_sessions_user_revoked_idx').on(table.userId, table.revokedAt),
    index('auth_sessions_expires_idx').on(table.expiresAt),
  ],
);

/**
 * `emailVerificationTokens`/`passwordResetTokens` are identical in shape:
 * immutable after consumption (`consumedAt` is the only field ever written
 * after INSERT, and only once), hence no `updatedAt`.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('email_verification_tokens_user_idx').on(table.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('password_reset_tokens_user_idx').on(table.userId)],
);

/**
 * Drizzle mirror of `db/migrations/0014_mfa_recovery_codes.sql` (P04a Unit
 * UA5b). Same user-keyed, no-`client_id` class as the three tables above;
 * immutable after the one-time `used_at` claim, hence no `updatedAt`.
 */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: bytea('code_hash').notNull().unique(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('mfa_recovery_codes_user_idx').on(table.userId)],
);
