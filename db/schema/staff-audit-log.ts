import { bigint, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `db/migrations/0058_topup_requests_and_staff_audit.sql`
 * (CREATE) and `db/migrations/0070_admin_staff_audit_impersonation_and_
 * plans.sql` (ALTER - P28 U1). `idempotencyKey`/`requestHash` are now
 * mandatory (backfilled + NOT NULL by migration 0070) and `idempotencyKey`
 * carries the UNIQUE authority (`staff_audit_log_idempotency_key_key`) the
 * internal API's replay-on-hit path requires (core invariant 3). `result`
 * is the first response body as compact JSON text, replayed verbatim on an
 * idempotency-key hit. `clientId` is nullable (NULL = platform-level
 * action), same `audit_logs` precedent (`./audit-logs.ts`). Deliberately NO
 * FK from `staffId` to `staff_users` - see migration 0070's header.
 */
export const staffAuditLog = pgTable(
  'staff_audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    staffId: uuid('staff_id').notNull(),
    action: text('action').notNull(),
    clientId: uuid('client_id'),
    targetRef: text('target_ref'),
    targetKind: text('target_kind'),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    result: text('result').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('staff_audit_log_idempotency_key_key').on(table.idempotencyKey)],
);
