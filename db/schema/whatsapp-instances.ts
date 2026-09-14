import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { clients } from './tenancy.js';
import { pauseReasonEnum, waHealthEnum, waLinkStateEnum } from './enums.js';

/**
 * Drizzle mirror of `db/migrations/0010_claim_join_shells.sql` -
 * `whatsapp_instances`, DDL-only shell (P08 owns its logic and ALTERs this
 * table). Excludes `current_fence`/`lease_seen_at` (live in
 * `instance_lease_state`) and `health_score` (P13's `instance_pacing_state`).
 * `owner_worker_id` was dropped by migration 0022 (P08 Unit U3) - it was a
 * dead duplicate of `instance_lease_state.owner_worker_id`, the real lease
 * ownership column since migration 0018.
 */
export const whatsappInstances = pgTable(
  'whatsapp_instances',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    label: text('label'),
    phoneE164: text('phone_e164'),
    ownerJid: text('owner_jid'),
    providerKind: text('provider_kind'),
    connectionStatus: text('connection_status'),
    healthState: waHealthEnum('health_state').notNull().default('never_linked'),
    linkState: waLinkStateEnum('link_state').default('unlinked'),
    desiredState: text('desired_state').notNull().default('offline'),
    sessionEpoch: integer('session_epoch').notNull().default(0),
    needsUserAction: boolean('needs_user_action').notNull().default(false),
    userActionReason: text('user_action_reason'),
    qrAttempts: integer('qr_attempts').notNull().default(0),
    pairingStartedAt: timestamp('pairing_started_at', { withTimezone: true }),
    pauseReason: pauseReasonEnum('pause_reason'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedByUserId: uuid('paused_by_user_id'),
    disconnectionReasonCode: text('disconnection_reason_code'),
    disconnectionReasonLabel: text('disconnection_reason_label'),
    disconnectionReasonAt: timestamp('disconnection_reason_at', { withTimezone: true }),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastSuccessSendAt: timestamp('last_success_send_at', { withTimezone: true }),
    lastErrorClass: text('last_error_class'),
    captureGroups: boolean('capture_groups').notNull().default(false),
    captureMedia: boolean('capture_media').notNull().default(false),
    // P21 (inbound-listener-receipts-and-optout) U1, migration 0063. The
    // per-instance inbound admission ceiling read by modules/inbound/
    // admission.ts - platform-set, no tenant write path in v1.
    inboundMaxPerMinute: integer('inbound_max_per_minute').notNull().default(120),
    // P24 (groups-messaging) Unit U1, migration 0066. The session worker's
    // group-sync clock: when the next sync is due, when one was explicitly
    // requested, and when one last completed.
    groupsNextSyncAfter: timestamp('groups_next_sync_after', { withTimezone: true }),
    groupsSyncRequestedAt: timestamp('groups_sync_requested_at', { withTimezone: true }),
    groupsLastSyncedAt: timestamp('groups_last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('wi_desired_state_values', sql`${table.desiredState} IN ('online', 'offline')`),
  ],
);
