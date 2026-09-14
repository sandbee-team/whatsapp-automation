/**
 * TS-side mirror of the canonical Postgres enum set created by
 * `db/migrations/0001_extensions_and_enums.sql` - labels verbatim, in the
 * exact declared order (order matters: `db/tests/enum-parity.test.ts`
 * asserts exact array equality against `enumsortorder`). `db/schema/enums.ts`
 * (Drizzle) derives its `pgEnum` label tuples FROM this module - this is the
 * single source of truth on the TS side, not restated there.
 *
 * Feature enums (broadcast, chat, contact) are intentionally NOT declared
 * here - same migration-placement rule as the SQL side: they arrive with
 * their owning feature.
 *
 * Pure consts/types only, no Node imports - this package also feeds a
 * browser build (`pnpm run domain:browser-build`).
 *
 * `job_status`'s type is exported here as `PgJobStatus`, not `JobStatus`:
 * `packages/domain/src/job/state-machine.ts` already declares and exports a
 * `JobStatus` type (identical labels, identical order) for the job FSM, and
 * both modules are re-exported from this package's barrel
 * (`packages/domain/src/index.ts`) - re-exporting a second, same-named
 * `JobStatus` type from here would collide with that existing export.
 */

export const JOB_STATUSES = [
  'created',
  'queued',
  'processing',
  'sent',
  'failed',
  'cancelled',
  'needs_reconcile',
  'blocked_needs_review',
] as const;
export type PgJobStatus = (typeof JOB_STATUSES)[number];

export const JOB_PRIORITIES = ['high', 'normal', 'low'] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const JOB_KINDS = ['text', 'media', 'reply'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const ATTEMPT_STATES = [
  'prepared',
  'dispatched',
  'acked',
  'failed',
  'reconciled_sent',
  'reconciled_lost',
  'abandoned',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const WA_HEALTHS = [
  'never_linked',
  'connected',
  'degraded',
  'paused',
  'logged_out',
] as const;
export type WaHealth = (typeof WA_HEALTHS)[number];

export const WA_LINK_STATES = ['unlinked', 'pairing', 'linked'] as const;
export type WaLinkState = (typeof WA_LINK_STATES)[number];

export const INSTANCE_DESIRED_STATES = ['online', 'offline'] as const;
export type InstanceDesiredState = (typeof INSTANCE_DESIRED_STATES)[number];

export const PAUSE_REASONS = [
  'user_action',
  'provider_restriction',
  'repeated_send_failure',
  'health_critical',
  'reconnect_failed',
  'pairing_expired',
  'session_replaced',
  'unknown_signal',
  'admin_action',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const CLIENT_STATUSES = ['pending_verification', 'active', 'suspended', 'closed'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MEMBERSHIP_ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const CLIENT_ONBOARDING_STEPS = [
  'verify_email',
  'choose_timezone',
  'accept_pacing_profile',
  'attest_consent',
  'connect_whatsapp',
  'send_test',
  'done',
] as const;
export type ClientOnboardingStep = (typeof CLIENT_ONBOARDING_STEPS)[number];

export const WALLET_STATES = ['active', 'low', 'empty', 'frozen'] as const;
export type WalletState = (typeof WALLET_STATES)[number];

export const WALLET_ENTRY_KINDS = [
  'signup_credit',
  'topup_manual',
  'topup_gateway',
  'promo_credit',
  'debit_send',
  'refund_send',
  'adjustment_credit',
  'adjustment_debit',
] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

// P03 delta enums (scope-delta doc, *Schema delta*): broadcast_status
// (campaigns), msg_direction (message_wa_ids - v1 writes 'out' rows only,
// migration 0008), chat_kind (v2 inbox/chat, ADR 0021; label set is a
// best-guess placeholder pending the v2 inbox design).
export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'snapshotting',
  'expanding',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const MSG_DIRECTIONS = ['in', 'out'] as const;
export type MsgDirection = (typeof MSG_DIRECTIONS)[number];

export const CHAT_KINDS = ['individual', 'group'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/**
 * `delivery_events.event_type` (P03 step 3) - the append-only per-job event
 * trail. Labels verbatim from the blueprint/dispatch.
 */
export const EVENT_TYPES = [
  'created',
  'queued',
  'claimed',
  'dispatched',
  'sent',
  'delivered',
  'read',
  'failed',
  'retry_scheduled',
  'paused_hold',
  'cancelled',
  'reconciled',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * `notifications.kind`/`notifications.severity` (P17 step 1, migration
 * 0048) - labels verbatim, in the exact declared order (db/tests/
 * enum-parity.test.ts asserts order equality).
 */
export const NOTIFICATION_KINDS = [
  'instance_paused',
  'instance_logged_out',
  'reconnect_budget_exhausted',
  'duplicate_fanout_ack_required',
  'unresolved_send',
  'plan_cap_reached',
  'infra_unavailable',
  'warmup_tier_changed',
  // P19 Unit U4 (step 6, migration 0059) - wallet low-balance/empty state
  // notifications. Appended (order matters for db/tests/enum-parity.test.ts).
  'wallet_low',
  'wallet_empty',
  // P24 (groups-messaging) Unit U1 (migration 0067) - a send into a group
  // came back forbidden. Appended (order matters for enum-parity.test.ts).
  'group_forbidden',
  // P25 observability-and-runbook Unit U3 (migration 0069) - a client's
  // trailing-24h opt-out rate crossed the per-client threshold. Appended.
  'optout_rate_high',
  // P28 (admin-internal-api-and-panel) Unit U1 (migration 0071) - staff-
  // action / admin-visible notification kinds. Appended, same order.
  'client_suspended',
  'client_reactivated',
  'wallet_frozen',
  'wallet_unfrozen',
  'wallet_credited_by_staff',
  'topup_rejected',
  'limits_changed',
  'pricing_changed',
  'pacing_relaxed',
  'instance_paused_by_staff',
  'instance_resumed_by_staff',
  'campaign_cancelled_by_staff',
  'impersonation_started',
  'impersonation_body_access',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * `topup_requests.status` (P19 step 2, migration 0058) - labels verbatim, in
 * the exact declared order (db/tests/enum-parity.test.ts asserts order
 * equality).
 */
export const TOPUP_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

// P20 (contacts-and-import) Unit U1 delta enums moved to ./p20-contacts.js
// (file-length cap); re-exported unchanged below.
export {
  CONTACT_SOURCES,
  type ContactSource,
  CONTACT_OPT_OUT_STATES,
  type ContactOptOutState,
  CONTACT_IMPORT_STATUSES,
  type ContactImportStatus,
  CONSENT_BASES,
  type ConsentBasis,
} from './p20-contacts.js';
import {
  CONTACT_SOURCES,
  CONTACT_OPT_OUT_STATES,
  CONTACT_IMPORT_STATUSES,
  CONSENT_BASES,
} from './p20-contacts.js';

/**
 * P23 (broadcast-campaigns) Unit U1 delta enum (migration 0064) -
 * `campaign_recipients.status`. Labels verbatim, in the exact declared
 * order (db/tests/enum-parity.test.ts asserts order equality). Deliberately
 * NO `'deferred'` label: `deferred` is a derived display bucket computed at
 * read time from a live pacing-deny check, never a stored recipient status
 * (see the scope delta and this phase's "Risks / gotchas").
 */
export const BROADCAST_RECIPIENT_STATUSES = [
  'pending',
  'skipped',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
] as const;
export type BroadcastRecipientStatus = (typeof BROADCAST_RECIPIENT_STATUSES)[number];

// P28 (admin-internal-api-and-panel) Unit U1 delta enums moved to
// ./p28-admin.js (file-length cap); re-exported unchanged below.
export {
  STAFF_ROLES,
  type StaffRole,
  IMPERSONATION_SCOPES,
  type ImpersonationScope,
} from './p28-admin.js';
import { STAFF_ROLES, IMPERSONATION_SCOPES } from './p28-admin.js';

/**
 * Manifest keyed by the exact Postgres type name - `db/tests/enum-parity.test.ts`
 * iterates this so an enum can never be silently skipped from the DB-parity
 * check in either direction.
 */
export const PG_ENUMS = {
  job_status: JOB_STATUSES,
  job_priority: JOB_PRIORITIES,
  job_kind: JOB_KINDS,
  attempt_state: ATTEMPT_STATES,
  wa_health: WA_HEALTHS,
  wa_link_state: WA_LINK_STATES,
  instance_desired_state: INSTANCE_DESIRED_STATES,
  pause_reason: PAUSE_REASONS,
  client_status: CLIENT_STATUSES,
  user_status: USER_STATUSES,
  membership_role: MEMBERSHIP_ROLES,
  client_onboarding_step: CLIENT_ONBOARDING_STEPS,
  wallet_state: WALLET_STATES,
  wallet_entry_kind: WALLET_ENTRY_KINDS,
  broadcast_status: BROADCAST_STATUSES,
  msg_direction: MSG_DIRECTIONS,
  chat_kind: CHAT_KINDS,
  event_type: EVENT_TYPES,
  notification_kind: NOTIFICATION_KINDS,
  notification_severity: NOTIFICATION_SEVERITIES,
  topup_status: TOPUP_STATUSES,
  contact_source: CONTACT_SOURCES,
  contact_opt_out_state: CONTACT_OPT_OUT_STATES,
  contact_import_status: CONTACT_IMPORT_STATUSES,
  consent_basis: CONSENT_BASES,
  broadcast_recipient_status: BROADCAST_RECIPIENT_STATUSES,
  staff_role: STAFF_ROLES,
  impersonation_scope: IMPERSONATION_SCOPES,
} as const;
