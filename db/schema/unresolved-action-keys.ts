import { bigint, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `db/migrations/0026_reconcile_support.sql` -
 * `unresolved_action_keys` (P12 U1, session-open correction C9). The
 * idempotency/replay authority for the human two-choice
 * retry/discard action on an already-existing `blocked_needs_review` job -
 * `message_job_refs` is scoped to job CREATION and cannot key this. PK
 * `(client_id, idempotency_key)` is the replay authority; append-only, same
 * class as `message_job_refs`/`delivery_event_ids` (no UPDATE/DELETE grant
 * to any role - the migration's own CHECK constraint on `action`
 * (`'retry' | 'discard'`) is not re-expressed here, matching this schema's
 * existing convention that constraints live only in the migration).
 */
export const unresolvedActionKeys = pgTable(
  'unresolved_action_keys',
  {
    clientId: uuid('client_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    messageJobId: bigint('message_job_id', { mode: 'bigint' }).notNull(),
    messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }).notNull(),
    action: text('action').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.idempotencyKey] })],
);
