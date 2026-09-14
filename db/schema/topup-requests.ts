import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { topupStatusEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0058_topup_requests_and_staff_audit.sql`
 * - `topup_requests`. `amountMinor` is `bigint` PAISE (mode: 'bigint'),
 * never a floating-point type - same discipline as every other money column
 * (`./wallet.ts`, `./wallet-guards.ts`). `UNIQUE (client_id, external_ref)`
 * is the idempotency authority for a tenant's duplicate top-up submission
 * (core invariant 3) - non-partitioned, so Postgres rejects a double submit
 * with 23505 directly.
 */
export const topupRequests = pgTable(
  'topup_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    method: text('method').notNull(),
    externalRef: text('external_ref').notNull(),
    status: topupStatusEnum('status').notNull().default('pending'),
    submittedByUserId: uuid('submitted_by_user_id'),
    reviewedByStaffId: uuid('reviewed_by_staff_id'),
    reviewReason: text('review_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (table) => [
    unique('topup_requests_client_external_ref_key').on(table.clientId, table.externalRef),
    check('topup_requests_amount_minor_positive', sql`${table.amountMinor} > 0`),
    check('topup_requests_method_check', sql`${table.method} IN ('upi', 'bank_transfer')`),
  ],
);
