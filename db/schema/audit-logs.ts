import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { inet } from './custom-types.js';

/**
 * Drizzle mirror of `db/migrations/0013_auth_and_onboarding.sql` -
 * `audit_logs`. Plain `pgTable` mirror only (same reasoning as
 * `wallet_ledger`/`message_jobs`/`delivery_events`): Drizzle cannot express
 * `PARTITION BY RANGE (...)`, so the monthly partitioning lives only in the
 * migration. `clientId` is deliberately nullable (NULL = platform-level
 * action) - see the migration's header comment for the isolation-registry
 * decision this drives.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id'),
    actorType: text('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorStaffId: uuid('actor_staff_id'),
    actorApiKeyId: uuid('actor_api_key_id'),
    impersonatedByStaffId: uuid('impersonated_by_staff_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata'),
    ip: inet('ip'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    check(
      'audit_logs_actor_type_check',
      sql`${table.actorType} IN ('user', 'api_key', 'staff', 'system')`,
    ),
  ],
);
