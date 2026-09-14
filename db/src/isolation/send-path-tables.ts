/**
 * Split out of `tenant-tables.ts` (P07 U2, to stay under the 300-line file
 * cap) - same registry, same consumer (`grants-snapshot.test.ts`'s
 * `wp_admin_app_has_no_write_grant_on_any_existing_send_path_table`).
 *
 * The tables a message send touches: job spine, uniqueness authorities,
 * receipts, pacing counters, money. Most of these arrive in P03/P13/P18;
 * the wp_admin_app write-revocation test (step 10) intersects this list
 * with the tables that exist today and grows itself as they land.
 *
 * `whatsapp_instances` carries health/desired_state/pause_reason - an admin
 * write grant there would be a staff-side resume mechanism, forbidden by
 * safety-compliance (no provider-evasion / no bypassing the fail-safe pause).
 * `campaigns`, `campaign_recipients` and `outbox_events` are the
 * broadcast/outbox send surfaces (reviewer M7).
 */
export const SEND_PATH_TABLES: readonly string[] = [
  'message_jobs',
  'message_job_refs',
  'message_wa_ids',
  'delivery_event_ids',
  'send_attempts',
  'delivery_events',
  'pacing_ledger',
  'client_daily_usage',
  'wallet_accounts',
  'wallet_ledger',
  'wallet_ledger_ext_refs',
  'wallet_charge_guards',
  'whatsapp_instances',
  'campaigns',
  'campaign_recipients',
  'outbox_events',
  // P06 (session-lease-and-fence), ADR 0029 SS4 (amends ADR 0022 SS2): an
  // admin write to the fence/owner_worker_id/lease_seen_at columns would be
  // a staff-side session-takeover primitive - the same forbidden class as
  // whatsapp_instances writes.
  'instance_lease_state',
  // P07 (session-auth-store) U2, migration 0020 (amends ADR 0022; ADR filed
  // this session for the wp_admin_app zero-grant decision): a session-
  // credential-takeover class primitive, and unlike whatsapp_instances even
  // admin SELECT is withheld (no legitimate staff read of session ciphertext).
  'whatsapp_session_credentials',
  'whatsapp_session_keys',
];
