import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { walletEntryKindEnum, walletStateEnum } from './enums.js';

/**
 * Drizzle mirrors of `db/migrations/0004_wallet_and_pricing.sql` - wallet and
 * pricing. All money columns are `bigint` PAISE (mode: 'bigint' - JS `number`
 * loses precision past 2^53 and lifetime totals are unbounded); never a
 * floating-point type (see `db/tests/wallet-schema.test.ts`'s generic scan).
 *
 * `wallet_ledger` is mirrored as a PLAIN `pgTable` - Drizzle has no API to
 * declare `PARTITION BY RANGE (...)`, so the partitioning itself (and the
 * monthly child tables the migration creates via `wp_ensure_month_partition`)
 * exists only in the migration, not here. `db/tests/schema-parity.test.ts`
 * only walks the parent's own columns, which are identical to the DDL.
 */

/**
 * Postgres `char(3)` (fixed-width currency code). Drizzle's built-in
 * `char()` builder reports `getSQLType()` as `char(3)`, which does not match
 * `information_schema.columns.udt_name` (`bpchar`) - this custom type
 * reports `bpchar` directly instead, the same trick `custom-types.ts` uses
 * for `citext`.
 */
const currencyCode = customType<{ data: string }>({
  dataType() {
    return 'bpchar';
  },
});

export const priceLists = pgTable('price_lists', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  currency: currencyCode('currency').notNull().default('INR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const priceListItems = pgTable(
  'price_list_items',
  {
    priceListKey: text('price_list_key')
      .notNull()
      .references(() => priceLists.key),
    priceKey: text('price_key').notNull(),
    rateMinor: bigint('rate_minor', { mode: 'bigint' }).notNull(), // PAISE; bigint; never floats
  },
  (table) => [
    primaryKey({ columns: [table.priceListKey, table.priceKey] }),
    check('price_list_items_rate_minor_positive', sql`${table.rateMinor} > 0`),
  ],
);

export const clientPricing = pgTable('client_pricing', {
  clientId: uuid('client_id')
    .primaryKey()
    .references(() => clients.id),
  priceListKey: text('price_list_key')
    .notNull()
    .references(() => priceLists.key),
  overrideItems: jsonb('override_items').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    clientId: uuid('client_id')
      .primaryKey()
      .references(() => clients.id),
    currency: currencyCode('currency').notNull().default('INR'),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull().default(0n),
    state: walletStateEnum('state').notNull().default('active'),
    lowBalanceThresholdMinor: bigint('low_balance_threshold_minor', { mode: 'bigint' })
      .notNull()
      .default(5000n),
    // NO DEFAULT, by design: set in the signup txn (ADR 0019 S1).
    maxRateMinor: bigint('max_rate_minor', { mode: 'bigint' }).notNull(),
    entrySeq: bigint('entry_seq', { mode: 'bigint' }).notNull().default(0n),
    checkpointSeq: bigint('checkpoint_seq', { mode: 'bigint' }).notNull().default(0n),
    checkpointBalanceMinor: bigint('checkpoint_balance_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    lifetimeCreditMinor: bigint('lifetime_credit_minor', { mode: 'bigint' }).notNull().default(0n),
    lifetimeDebitMinor: bigint('lifetime_debit_minor', { mode: 'bigint' }).notNull().default(0n),
    lastLowWarningAt: timestamp('last_low_warning_at', { withTimezone: true }),
    lastEmptyAt: timestamp('last_empty_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('wallet_accounts_max_rate_minor_positive', sql`${table.maxRateMinor} > 0`)],
);

/**
 * Plain `pgTable` mirror only - see the module doc above for why the
 * `PARTITION BY RANGE (created_at)` and monthly children are NOT (and
 * cannot be) represented here.
 *
 * PK is `(client_id, seq, created_at)`, not the `(client_id, seq)` the
 * product spec names: a unique constraint on a partitioned table must
 * include every partition-key column (Postgres rejects otherwise; mandatory
 * test 21 in `db/tests/partitions.test.ts` polices this repo-wide).
 * Operational `(client_id, seq)` uniqueness is enforced procedurally instead
 * - `seq` is allocated from `wallet_accounts.entry_seq` under that row's
 * lock (P18 builds the allocator).
 */
export const walletLedger = pgTable(
  'wallet_ledger',
  {
    clientId: uuid('client_id').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    kind: walletEntryKindEnum('kind').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(), // signed: credit > 0, debit < 0
    balanceAfterMinor: bigint('balance_after_minor', { mode: 'bigint' }).notNull(),
    priceKey: text('price_key'),
    rateMinor: bigint('rate_minor', { mode: 'bigint' }),
    quantity: integer('quantity').notNull().default(1),
    instanceId: uuid('instance_id'),
    campaignId: uuid('campaign_id'),
    messageJobId: bigint('message_job_id', { mode: 'bigint' }),
    messageJobCreatedAt: timestamp('message_job_created_at', { withTimezone: true }),
    sendAttemptId: bigint('send_attempt_id', { mode: 'bigint' }),
    actorType: text('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    actorStaffId: uuid('actor_staff_id'),
    reason: text('reason'),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.seq, table.createdAt] })],
);

/** The NON-partitioned external_ref uniqueness authority - see migration 0004. */
export const walletLedgerExtRefs = pgTable(
  'wallet_ledger_ext_refs',
  {
    clientId: uuid('client_id').notNull(),
    externalRef: text('external_ref').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(), // pointer to the ledger row it guards
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.externalRef] })],
);
