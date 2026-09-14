import type { PgTable } from 'drizzle-orm/pg-core';
import { clients, memberships, planLimits, plans, users } from './tenancy.js';
import {
  clientPricing,
  priceListItems,
  priceLists,
  walletAccounts,
  walletLedger,
  walletLedgerExtRefs,
} from './wallet.js';
import {
  walletChargeGuards,
  walletDailySummary,
  walletReconcileFindings,
} from './wallet-guards.js';
import { messageJobs } from './message-jobs.js';
import { messageJobRefs } from './message-job-refs.js';
import { messageWaIds } from './message-wa-ids.js';
import { unresolvedActionKeys } from './unresolved-action-keys.js';
import { deliveryEventIds } from './delivery-event-ids.js';
import { sendAttempts } from './send-attempts.js';
import { deliveryEvents } from './delivery-events.js';
import { whatsappInstances } from './whatsapp-instances.js';
import { instanceLeaseState } from './instance-lease-state.js';
import { campaigns } from './campaigns.js';
import { campaignRecipients } from './campaign-recipients.js';
import { campaignCounters } from './campaign-counters.js';
import { whatsappSessionCredentials } from './whatsapp-session-credentials.js';
import { whatsappSessionKeys } from './whatsapp-session-keys.js';
import {
  authSessions,
  emailVerificationTokens,
  mfaRecoveryCodes,
  passwordResetTokens,
} from './auth.js';
import { auditLogs } from './audit-logs.js';
import { pacingProfiles } from './pacing-profiles.js';
import { pacingWarmupTiers } from './pacing-warmup-tiers.js';
import { instancePacingState } from './instance-pacing-state.js';
import { pacingLedger } from './pacing-ledger.js';
import { clientDailyUsage } from './client-daily-usage.js';
import { pacingEvents } from './pacing-events.js';
import { instancePacingOverrides, clientLimitOverrides } from './instance-pacing-overrides.js';
import { optOuts } from './opt-outs.js';
import { optoutConfirmations } from './optout-confirmations.js';
import { tenantOptoutKeywords } from './tenant-optout-keywords.js';
import { tenantBlockedWords } from './tenant-blocked-words.js';
import { contentFingerprints } from './content-fingerprints.js';
import { contentFingerprintRecipients } from './content-fingerprint-recipients.js';
import { recipientSendBuckets } from './recipient-send-buckets.js';
import { instanceRecipientContacts } from './instance-recipient-contacts.js';
import { outboxEvents } from './outbox-events.js';
import { webhookEndpoints } from './webhook-endpoints.js';
import { webhookDeliveries } from './webhook-deliveries.js';
import { instanceHealthSamples } from './instance-health-samples.js';
import { topupRequests } from './topup-requests.js';
import { staffAuditLog } from './staff-audit-log.js';
import { staffUsers } from './staff-users.js';
import { staffSessions } from './staff-sessions.js';
import { impersonationGrants } from './impersonation-grants.js';
import { contacts } from './contacts.js';
import { contactTags } from './contact-tags.js';
import { contactTagLinks } from './contact-tag-links.js';
import { contactImports } from './contact-imports.js';
import { contactImportErrors } from './contact-import-errors.js';
import { inboundDeadLetters } from './inbound-dead-letters.js';
import { consentRecords } from './consent-records.js';
import { waGroups } from './wa-groups.js';
import { leads } from './leads.js';
import { apiKeys } from './api-keys.js';
import { mediaAssets } from './media-assets.js';

/**
 * Manifest of every mirrored Drizzle table, keyed by its Postgres table
 * name. `db/tests/schema-parity.test.ts` walks this array so any new
 * mirror (wallet tables, etc. in later steps) is automatically covered by
 * the parity check without editing the test itself.
 */
export interface SchemaTableEntry {
  tableName: string;
  table: PgTable;
}

export const SCHEMA_TABLES: SchemaTableEntry[] = [
  { tableName: 'plans', table: plans },
  { tableName: 'plan_limits', table: planLimits },
  { tableName: 'users', table: users },
  { tableName: 'clients', table: clients },
  { tableName: 'memberships', table: memberships },
  { tableName: 'price_lists', table: priceLists },
  { tableName: 'price_list_items', table: priceListItems },
  { tableName: 'client_pricing', table: clientPricing },
  { tableName: 'wallet_accounts', table: walletAccounts },
  { tableName: 'wallet_ledger', table: walletLedger },
  { tableName: 'wallet_ledger_ext_refs', table: walletLedgerExtRefs },
  { tableName: 'message_jobs', table: messageJobs },
  { tableName: 'message_job_refs', table: messageJobRefs },
  { tableName: 'message_wa_ids', table: messageWaIds },
  { tableName: 'unresolved_action_keys', table: unresolvedActionKeys },
  { tableName: 'delivery_event_ids', table: deliveryEventIds },
  { tableName: 'send_attempts', table: sendAttempts },
  { tableName: 'delivery_events', table: deliveryEvents },
  { tableName: 'whatsapp_instances', table: whatsappInstances },
  { tableName: 'instance_lease_state', table: instanceLeaseState },
  { tableName: 'campaigns', table: campaigns },
  // P23 (broadcast-campaigns) Unit U1, migration 0064.
  { tableName: 'campaign_recipients', table: campaignRecipients },
  { tableName: 'campaign_counters', table: campaignCounters },
  { tableName: 'whatsapp_session_credentials', table: whatsappSessionCredentials },
  { tableName: 'whatsapp_session_keys', table: whatsappSessionKeys },
  { tableName: 'auth_sessions', table: authSessions },
  { tableName: 'email_verification_tokens', table: emailVerificationTokens },
  { tableName: 'password_reset_tokens', table: passwordResetTokens },
  { tableName: 'audit_logs', table: auditLogs },
  { tableName: 'mfa_recovery_codes', table: mfaRecoveryCodes },
  // P13 (pacing-and-warmup) Unit U1, migration 0030/0031. `effective_client_
  // limits` is a VIEW, not a table, and is deliberately NOT listed here -
  // schema-parity.test.ts walks TABLE columns only.
  { tableName: 'pacing_profiles', table: pacingProfiles },
  { tableName: 'pacing_warmup_tiers', table: pacingWarmupTiers },
  { tableName: 'instance_pacing_state', table: instancePacingState },
  { tableName: 'pacing_ledger', table: pacingLedger },
  { tableName: 'client_daily_usage', table: clientDailyUsage },
  { tableName: 'pacing_events', table: pacingEvents },
  { tableName: 'instance_pacing_overrides', table: instancePacingOverrides },
  { tableName: 'client_limit_overrides', table: clientLimitOverrides },
  // P14 (safe-mode-guards) Unit U1, migration 0036.
  { tableName: 'opt_outs', table: optOuts },
  { tableName: 'optout_confirmations', table: optoutConfirmations },
  { tableName: 'tenant_optout_keywords', table: tenantOptoutKeywords },
  { tableName: 'tenant_blocked_words', table: tenantBlockedWords },
  { tableName: 'content_fingerprints', table: contentFingerprints },
  { tableName: 'content_fingerprint_recipients', table: contentFingerprintRecipients },
  { tableName: 'recipient_send_buckets', table: recipientSendBuckets },
  { tableName: 'instance_recipient_contacts', table: instanceRecipientContacts },
  // P15 (outbox-relay-and-webhooks) Unit U1, migration 0041.
  { tableName: 'outbox_events', table: outboxEvents },
  { tableName: 'webhook_endpoints', table: webhookEndpoints },
  { tableName: 'webhook_deliveries', table: webhookDeliveries },
  // P16 (health-signals-and-pause) Unit A, migration 0044.
  { tableName: 'instance_health_samples', table: instanceHealthSamples },
  // P18 (wallet-ledger-and-pricing) Unit U1, migration 0051.
  { tableName: 'wallet_charge_guards', table: walletChargeGuards },
  { tableName: 'wallet_daily_summary', table: walletDailySummary },
  { tableName: 'wallet_reconcile_findings', table: walletReconcileFindings },
  // P19 (topup-and-staff-audit) Unit U1, migration 0058.
  { tableName: 'topup_requests', table: topupRequests },
  { tableName: 'staff_audit_log', table: staffAuditLog },
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
  { tableName: 'staff_users', table: staffUsers },
  { tableName: 'staff_sessions', table: staffSessions },
  { tableName: 'impersonation_grants', table: impersonationGrants },
  // P20 (contacts-and-import) Unit U1, migration 0060.
  { tableName: 'contacts', table: contacts },
  { tableName: 'contact_tags', table: contactTags },
  { tableName: 'contact_tag_links', table: contactTagLinks },
  { tableName: 'contact_imports', table: contactImports },
  { tableName: 'contact_import_errors', table: contactImportErrors },
  { tableName: 'consent_records', table: consentRecords },
  // P21 (inbound-listener-receipts-and-optout) Unit U1, migration 0063.
  { tableName: 'inbound_dead_letters', table: inboundDeadLetters },
  // P24 (groups-messaging) Unit U1, migration 0066.
  { tableName: 'wa_groups', table: waGroups },
  // P29 (website-and-launch-hardening) Unit U4a, migration 0074.
  { tableName: 'leads', table: leads },
  // Go-live session, Unit U1, migration 0076.
  { tableName: 'api_keys', table: apiKeys },
  // P34 U-upload (ADR 0052 accepted scope), migration 0077.
  { tableName: 'media_assets', table: mediaAssets },
];

export * from './enums.js';
export * from './tenancy.js';
export * from './wallet.js';
export * from './message-jobs.js';
export * from './message-job-refs.js';
export * from './message-wa-ids.js';
export * from './unresolved-action-keys.js';
export * from './delivery-event-ids.js';
export * from './send-attempts.js';
export * from './delivery-events.js';
export * from './whatsapp-instances.js';
export * from './instance-lease-state.js';
export * from './campaigns.js';
export * from './campaign-recipients.js';
export * from './campaign-counters.js';
export * from './whatsapp-session-credentials.js';
export * from './whatsapp-session-keys.js';
export * from './auth.js';
export * from './audit-logs.js';
export * from './pacing-profiles.js';
export * from './pacing-warmup-tiers.js';
export * from './instance-pacing-state.js';
export * from './pacing-ledger.js';
export * from './client-daily-usage.js';
export * from './pacing-events.js';
export * from './instance-pacing-overrides.js';
export * from './opt-outs.js';
export * from './optout-confirmations.js';
export * from './tenant-optout-keywords.js';
export * from './tenant-blocked-words.js';
export * from './content-fingerprints.js';
export * from './content-fingerprint-recipients.js';
export * from './recipient-send-buckets.js';
export * from './instance-recipient-contacts.js';
export * from './outbox-events.js';
export * from './webhook-endpoints.js';
export * from './webhook-deliveries.js';
export * from './instance-health-samples.js';
export * from './wallet-guards.js';
export * from './topup-requests.js';
export * from './staff-audit-log.js';
export * from './contacts.js';
export * from './contact-tags.js';
export * from './contact-tag-links.js';
export * from './contact-imports.js';
export * from './contact-import-errors.js';
export * from './consent-records.js';
export * from './inbound-dead-letters.js';
export * from './wa-groups.js';
export * from './staff-users.js';
export * from './staff-sessions.js';
export * from './impersonation-grants.js';
export * from './leads.js';
export * from './api-keys.js';
export * from './media-assets.js';
