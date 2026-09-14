import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ATTEMPT_STATES,
  BROADCAST_RECIPIENT_STATUSES,
  BROADCAST_STATUSES,
  CHAT_KINDS,
  CLIENT_ONBOARDING_STEPS,
  CLIENT_STATUSES,
  CONSENT_BASES,
  CONTACT_IMPORT_STATUSES,
  CONTACT_OPT_OUT_STATES,
  CONTACT_SOURCES,
  EVENT_TYPES,
  IMPERSONATION_SCOPES,
  INSTANCE_DESIRED_STATES,
  JOB_KINDS,
  JOB_PRIORITIES,
  JOB_STATUSES,
  MEMBERSHIP_ROLES,
  MSG_DIRECTIONS,
  PAUSE_REASONS,
  STAFF_ROLES,
  TOPUP_STATUSES,
  USER_STATUSES,
  WA_HEALTHS,
  WA_LINK_STATES,
  WALLET_ENTRY_KINDS,
  WALLET_STATES,
} from '@wp/domain';

/**
 * Drizzle mirrors of the canonical Postgres enums created by
 * `db/migrations/0001_extensions_and_enums.sql`. Labels are derived FROM
 * `@wp/domain`'s `PG_ENUMS`/`*_STATUSES` arrays - not restated here - so the
 * TS-side label list has exactly one source of truth
 * (`db/tests/enum-parity.test.ts` is the parity check against Postgres
 * itself). Drizzle's `pgEnum` wants a mutable tuple, hence the `[...X]`
 * spreads below.
 *
 * `db/schema/**` is intentionally outside `db/tsconfig.json`'s build
 * include - tests transpile it directly.
 */
export const jobStatusEnum = pgEnum('job_status', [...JOB_STATUSES]);
export const jobPriorityEnum = pgEnum('job_priority', [...JOB_PRIORITIES]);
export const jobKindEnum = pgEnum('job_kind', [...JOB_KINDS]);
export const attemptStateEnum = pgEnum('attempt_state', [...ATTEMPT_STATES]);
export const waHealthEnum = pgEnum('wa_health', [...WA_HEALTHS]);
export const waLinkStateEnum = pgEnum('wa_link_state', [...WA_LINK_STATES]);
export const instanceDesiredStateEnum = pgEnum('instance_desired_state', [
  ...INSTANCE_DESIRED_STATES,
]);
export const pauseReasonEnum = pgEnum('pause_reason', [...PAUSE_REASONS]);
export const clientStatusEnum = pgEnum('client_status', [...CLIENT_STATUSES]);
export const userStatusEnum = pgEnum('user_status', [...USER_STATUSES]);
export const membershipRoleEnum = pgEnum('membership_role', [...MEMBERSHIP_ROLES]);
export const clientOnboardingStepEnum = pgEnum('client_onboarding_step', [
  ...CLIENT_ONBOARDING_STEPS,
]);
export const walletStateEnum = pgEnum('wallet_state', [...WALLET_STATES]);
export const walletEntryKindEnum = pgEnum('wallet_entry_kind', [...WALLET_ENTRY_KINDS]);
// P03 delta enums - see db/migrations/0008_queue_uniqueness_authorities.sql
// and 0009_delivery_events.sql.
export const broadcastStatusEnum = pgEnum('broadcast_status', [...BROADCAST_STATUSES]);
export const msgDirectionEnum = pgEnum('msg_direction', [...MSG_DIRECTIONS]);
export const chatKindEnum = pgEnum('chat_kind', [...CHAT_KINDS]);
export const eventTypeEnum = pgEnum('event_type', [...EVENT_TYPES]);
// P19 delta enum - see db/migrations/0058_topup_requests_and_staff_audit.sql.
export const topupStatusEnum = pgEnum('topup_status', [...TOPUP_STATUSES]);
// P20 (contacts-and-import) Unit U1, migration 0060.
export const contactSourceEnum = pgEnum('contact_source', [...CONTACT_SOURCES]);
export const contactOptOutStateEnum = pgEnum('contact_opt_out_state', [...CONTACT_OPT_OUT_STATES]);
export const contactImportStatusEnum = pgEnum('contact_import_status', [
  ...CONTACT_IMPORT_STATUSES,
]);
export const consentBasisEnum = pgEnum('consent_basis', [...CONSENT_BASES]);
// P23 (broadcast-campaigns) Unit U1, migration 0064.
export const broadcastRecipientStatusEnum = pgEnum('broadcast_recipient_status', [
  ...BROADCAST_RECIPIENT_STATUSES,
]);
// P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
export const staffRoleEnum = pgEnum('staff_role', [...STAFF_ROLES]);
export const impersonationScopeEnum = pgEnum('impersonation_scope', [...IMPERSONATION_SCOPES]);
