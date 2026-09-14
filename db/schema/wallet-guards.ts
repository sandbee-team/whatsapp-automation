import {
  bigint,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { walletEntryKindEnum } from './enums.js';

/**
 * Drizzle mirrors of `db/migrations/0051_wallet_guards_and_rollups.sql`.
 * All money columns are `bigint` PAISE (mode: 'bigint'); never a
 * floating-point type (see `db/tests/wallet-guards-schema.test.ts`'s
 * generic scan).
 *
 * `wallet_charge_guards` is mirrored as a PLAIN `pgTable`, same as
 * `wallet_ledger` (`./wallet.ts`) - Drizzle has no API to declare
 * `PARTITION BY RANGE (...)`, so the partitioning itself (and the monthly
 * child tables the migration creates via `wp_ensure_month_partition`)
 * exists only in the migration, not here.
 */

/**
 * The idempotency authority for send-linked money (ADR 0019 SS1-2).
 * `created_at` carries NO DEFAULT, by design (ADR 0038 SS1): every writer
 * stamps it in-statement with the charged job's own `message_jobs.
 * created_at`, never `now()`.
 */
export const walletChargeGuards = pgTable(
  'wallet_charge_guards',
  {
    sendAttemptId: bigint('send_attempt_id', { mode: 'bigint' }).notNull(),
    kind: walletEntryKindEnum('kind').notNull(),
    clientId: uuid('client_id').notNull(),
    // 0 = inserted, ledger row not yet stamped (reconciler check E hunts these).
    ledgerSeq: bigint('ledger_seq', { mode: 'bigint' }).notNull().default(0n),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.sendAttemptId, table.kind, table.createdAt] })],
);

export const walletDailySummary = pgTable(
  'wallet_daily_summary',
  {
    clientId: uuid('client_id').notNull(),
    day: date('day').notNull(), // UTC calendar day of wallet_ledger.created_at
    instanceId: uuid('instance_id').notNull(),
    sentCount: integer('sent_count').notNull().default(0),
    debitMinor: bigint('debit_minor', { mode: 'bigint' }).notNull().default(0n),
    creditMinor: bigint('credit_minor', { mode: 'bigint' }).notNull().default(0n),
    refundMinor: bigint('refund_minor', { mode: 'bigint' }).notNull().default(0n),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.day, table.instanceId] })],
);

export const walletReconcileFindings = pgTable(
  'wallet_reconcile_findings',
  {
    clientId: uuid('client_id').notNull(),
    id: bigint('id', { mode: 'bigint' }).notNull(), // GENERATED ALWAYS AS IDENTITY in the DDL
    kind: text('kind').notNull(),
    detail: jsonb('detail').notNull().default({}),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.id] })],
);
