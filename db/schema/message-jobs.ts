import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './custom-types.js';
import { jobKindEnum, jobPriorityEnum, jobStatusEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0007_message_jobs.sql` - `message_jobs`,
 * the durable queue spine. Plain `pgTable` mirror only (same reasoning as
 * `wallet_ledger` in `db/schema/wallet.ts`): Drizzle has no API to declare
 * `PARTITION BY RANGE (...)`, so the partitioning itself (and the monthly
 * child tables `db/src/partitions.ts` maintains) exists only in the
 * migration, not here. NO foreign keys anywhere on this table, in either
 * direction - see the migration header for why.
 */
export const messageJobs = pgTable(
  'message_jobs',
  {
    id: bigint('id', { mode: 'bigint' }).notNull(),
    clientId: uuid('client_id').notNull(),
    instanceId: uuid('instance_id').notNull(),
    sessionEpoch: integer('session_epoch').notNull().default(0),
    campaignId: uuid('campaign_id'),
    recipientJid: text('recipient_jid').notNull(),
    recipientE164: text('recipient_e164'),
    recipientHash: bytea('recipient_hash'),
    payload: jsonb('payload').notNull(),
    payloadKind: jobKindEnum('payload_kind').notNull(),
    priority: jobPriorityEnum('priority').notNull(),
    priorityRank: smallint('priority_rank').notNull(),
    status: jobStatusEnum('status').notNull().default('created'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    leaseOwner: text('lease_owner'),
    leaseId: uuid('lease_id'),
    ownerFence: bigint('owner_fence', { mode: 'bigint' }),
    leasedAt: timestamp('leased_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    lastErrorClass: text('last_error_class'),
    pacingReservedAt: timestamp('pacing_reserved_at', { withTimezone: true }),
    pacingRefundedAt: timestamp('pacing_refunded_at', { withTimezone: true }),
    pacingLedgerDate: date('pacing_ledger_date'),
    pacingDenyReason: text('pacing_deny_reason'),
    pacingDeferrals: integer('pacing_deferrals').notNull().default(0),
    isNewConversation: boolean('is_new_conversation').notNull().default(false),
    contentFingerprint: bytea('content_fingerprint'),
    contentFingerprintCountedAt: timestamp('content_fingerprint_counted_at', {
      withTimezone: true,
    }),
    sendOrigin: text('send_origin'),
    needsUserAction: boolean('needs_user_action').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    createdByApiKeyId: uuid('created_by_api_key_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // P12 U1 (`db/migrations/0026_reconcile_support.sql`) - the human-review
    // reason/timestamp pair; `needsUserAction` above stays boolean, unchanged
    // (session-open correction C1).
    unresolvedReason: text('unresolved_reason'),
    unresolvedAt: timestamp('unresolved_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.createdAt] }),
    check('mj_payload_size', sql`octet_length(${table.payload}::text) <= 2048`),
    check(
      'mj_attempts_range',
      sql`${table.attempts} >= 0 AND ${table.attempts} <= ${table.maxAttempts} + 1`,
    ),
    check('mj_sent_has_sent_at', sql`${table.status} <> 'sent' OR ${table.sentAt} IS NOT NULL`),
    check(
      'mj_recipient_shape',
      sql`${table.recipientE164} IS NOT NULL OR ${table.recipientJid} LIKE '%@g.us'`,
    ),
  ],
);
