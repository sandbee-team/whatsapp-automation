import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea, inet } from './custom-types.js';
import { staffUsers } from './staff-users.js';

/**
 * Drizzle mirror of `db/migrations/0070_admin_staff_audit_impersonation_and_
 * plans.sql` - `staff_sessions`. One row per staff login/refresh-token
 * session, non-tenant. `userAgentHash` is `text` (a hash, never the raw UA),
 * same idiom as `auth_sessions.userAgentHash` (`./auth.ts`).
 */
export const staffSessions = pgTable('staff_sessions', {
  id: uuid('id').primaryKey(),
  staffId: uuid('staff_id')
    .notNull()
    .references(() => staffUsers.id),
  refreshTokenHash: bytea('refresh_token_hash').notNull().unique(),
  ip: inet('ip'),
  userAgentHash: text('user_agent_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedBy: uuid('replaced_by'),
});
