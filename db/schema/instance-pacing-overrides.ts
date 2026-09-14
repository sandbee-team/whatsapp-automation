import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { whatsappInstances } from './whatsapp-instances.js';

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` -
 * `instance_pacing_overrides`, tenant-tighten / admin-relax exceptions to
 * the profile-derived limits, each with a reason, actor and optional
 * expiry.
 */
export const instancePacingOverrides = pgTable(
  'instance_pacing_overrides',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => whatsappInstances.id),
    kind: text('kind').notNull(),
    patch: jsonb('patch'),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
    actorStaffId: uuid('actor_staff_id'),
    // Stamped once by the expiry sweep that re-resolves eff_* after an
    // admin_relax override lapses - lets the sweep find "expired but not
    // yet reconciled" rows without a second table.
    expiryAppliedAt: timestamp('expiry_applied_at', { withTimezone: true }),
  },
  (table) => [check('ipo_kind_check', sql`${table.kind} IN ('tenant_tighten', 'admin_relax')`)],
);

/**
 * Drizzle mirror of `db/migrations/0030_pacing.sql` -
 * `client_limit_overrides`. No dedicated schema file was assigned this
 * table in this unit's file scope (it is a P02-scoped table this phase's
 * step 2 prerequisite creates, per the migration's own header); it lives
 * here alongside its sibling override table rather than in a new file. PK
 * `(client_id, limit_key)` already leads with `client_id` - no
 * `CANONICAL_AUTHORITY_KEYS` entry needed. Its resolution VIEW
 * (`effective_client_limits`) is NOT mirrored here - Drizzle mirrors are
 * for TABLEs only (see `db/schema/index.ts`'s manifest comment).
 */
export const clientLimitOverrides = pgTable(
  'client_limit_overrides',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    limitKey: text('limit_key').notNull(),
    limitValue: integer('limit_value'),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
    actorStaffId: uuid('actor_staff_id'),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.limitKey] })],
);
