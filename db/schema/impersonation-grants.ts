import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { impersonationScopeEnum } from './enums.js';
import { staffUsers } from './staff-users.js';

/**
 * Drizzle mirror of `db/migrations/0070_admin_staff_audit_impersonation_and_
 * plans.sql` - `impersonation_grants`. Tenant table (client_id NOT NULL,
 * RLS ENABLE+FORCE, standard tenant_isolation policy). Hard time-bound
 * ceilings are enforced by CHECK at the storage layer, not application code
 * - see the migration's own header for the "why storage-level, not just
 * API-level" rationale.
 */
export const impersonationGrants = pgTable(
  'impersonation_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffUsers.id),
    targetUserId: uuid('target_user_id'),
    scope: impersonationScopeEnum('scope').notNull().default('metadata_only'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    parentGrantId: uuid('parent_grant_id'),
  },
  (table) => [
    check('impersonation_grants_reason_not_blank', sql`length(btrim(${table.reason})) > 0`),
    check(
      'impersonation_grants_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'impersonation_grants_max_thirty_minutes',
      sql`${table.expiresAt} <= ${table.createdAt} + interval '30 minutes'`,
    ),
    check(
      'impersonation_grants_body_scope_max_fifteen_minutes',
      sql`${table.scope} <> 'with_message_bodies' OR ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
  ],
);
