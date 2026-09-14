/**
 * P02 step 8 - the ONE tenant-table registry. Consumed by:
 *  - the isolation suite A (step 9, live pg_class/pg_indexes checks),
 *  - the grant-snapshot test (step 10),
 *  - `scripts/check-tenant-scope.ts` (derives `TENANT_TABLES` from
 *    `TENANT_TABLE_COVERAGE`'s keys).
 *
 * Nothing here touches a database connection or the filesystem - this file
 * is data only, so it is safe to import from both `db/src` (shipped runtime
 * code) and `scripts/` (repo tooling).
 */

/**
 * Tenant table -> tenant-key column. `clients` is the tenant root: its RLS
 * policy (migration 0005) predicates on `id`, not `client_id`, because the
 * client row IS the tenant. Every other tenant table carries `client_id`.
 *
 * Partition children (e.g. a future `wallet_ledger_y2026m08`) are
 * deliberately NOT listed here: they inherit their parent's tenant-key
 * column and RLS policy, and the live suites resolve a child to its parent
 * via `pg_inherits` before looking it up in this map (see
 * `coverage.ts#CatalogTableRow.parentTable`).
 */
export const TENANT_TABLE_COVERAGE: Readonly<Record<string, string>> = {
  clients: 'id',
  memberships: 'client_id',
  client_pricing: 'client_id',
  wallet_accounts: 'client_id',
  wallet_ledger: 'client_id',
  wallet_ledger_ext_refs: 'client_id',
  // P03 (db-queue-and-claim) additions. All nine are real RLS-enforced
  // tenant tables (client_id NOT NULL + the tenant_isolation policy - see
  // migrations 0007-0010), so they belong here for the coverage check
  // (`checkCoverage` / `every_base_table_and_partition_is_tenant_covered_or_
  // allow_listed_with_a_reason`). Several of these tables' PK (or, for
  // message_jobs, a canon-mandated secondary index) legitimately does NOT
  // lead with client_id - none of the five shapes involved
  // (partition-key PK / globally-unique-id PK / surrogate PK / the two
  // deliberately-global secondary indexes on message_jobs/send_attempts) is
  // one of the exactly-three `SUITE_A_INDEX_EXEMPTIONS` names, so P03 Unit C
  // (step 7) registers each one explicitly in `CANONICAL_AUTHORITY_KEYS`
  // below instead, with a one-line reason apiece, consumed by
  // `db/tests/isolation-suite-a.test.ts`'s
  // `every_tenant_index_leads_with_client_id_except_the_three_named_exemptions`
  // case. The coverage check itself (this table existing + carrying
  // client_id) is correct and green as registered.
  message_jobs: 'client_id',
  message_job_refs: 'client_id',
  message_wa_ids: 'client_id',
  delivery_event_ids: 'client_id',
  send_attempts: 'client_id',
  delivery_events: 'client_id',
  whatsapp_instances: 'client_id',
  instance_lease_state: 'client_id',
  campaigns: 'client_id',
  // P07 (session-auth-store) U2, migration 0020: RLS-FORCE'd tenant tables
  // whose PK leads with instance_id - see CANONICAL_AUTHORITY_KEYS below.
  whatsapp_session_credentials: 'client_id',
  whatsapp_session_keys: 'client_id',
  // P12 (queue-recovery-and-echo-spike) U1, migration 0026: the human
  // retry/discard action's own idempotency/replay authority (session-open
  // correction C9). PK (client_id, idempotency_key) already leads with
  // client_id, so it needs no CANONICAL_AUTHORITY_KEYS entry below.
  unresolved_action_keys: 'client_id',
  // P13 U1, migration 0030: only pacing_ledger's PK is non-client_id-leading (CANONICAL_AUTHORITY_KEYS below).
  instance_pacing_state: 'client_id',
  pacing_ledger: 'client_id',
  client_daily_usage: 'client_id',
  pacing_events: 'client_id',
  instance_pacing_overrides: 'client_id',
  client_limit_overrides: 'client_id',
  // P14 (safe-mode-guards) U1, migration 0036: every PK below already leads
  // with client_id, so NONE of these eight tables needs a
  // CANONICAL_AUTHORITY_KEYS entry.
  opt_outs: 'client_id',
  optout_confirmations: 'client_id',
  tenant_optout_keywords: 'client_id',
  tenant_blocked_words: 'client_id',
  content_fingerprints: 'client_id',
  content_fingerprint_recipients: 'client_id',
  recipient_send_buckets: 'client_id',
  instance_recipient_contacts: 'client_id',
  // P15 (outbox-relay-and-webhooks) Unit U1, migration 0041. All three PKs
  // are surrogate (bigint identity or app-generated uuid) handles, not
  // client_id-leading - each is registered in CANONICAL_AUTHORITY_KEYS below,
  // same class as whatsapp_instances/campaigns/pacing_events/send_attempts.
  outbox_events: 'client_id',
  webhook_endpoints: 'client_id',
  webhook_deliveries: 'client_id',
  // P16 (health-signals-and-pause) Unit A, migration 0044. Surrogate uuid PK
  // (not client_id-leading), registered in CANONICAL_AUTHORITY_KEYS below,
  // same class as pacing_events/webhook_endpoints.
  instance_health_samples: 'client_id',
  // P17 (notifications-and-instance-card) Unit U1, migration 0048. Surrogate
  // uuid PK (not client_id-leading), registered in CANONICAL_AUTHORITY_KEYS
  // below, same class as instance_health_samples/webhook_endpoints.
  notifications: 'client_id',
  // P18 (wallet-ledger-and-pricing) U1, migration 0051.
  wallet_charge_guards: 'client_id',
  wallet_daily_summary: 'client_id',
  wallet_reconcile_findings: 'client_id',
  // P19 (topup-and-staff-audit) U1, migration 0058. PK (id) is a surrogate
  // uuid, not client_id-leading - registered in CANONICAL_AUTHORITY_KEYS
  // below, same class as whatsapp_instances/campaigns.
  topup_requests: 'client_id',
  // P20 (contacts-and-import) Unit U1, migration 0060. contacts/contact_tags/
  // contact_imports/consent_records have surrogate uuid PKs (not client_id-
  // leading), registered in CANONICAL_AUTHORITY_KEYS below, same class as
  // topup_requests/webhook_endpoints. contact_tag_links' PK already leads
  // with client_id. contact_import_errors is the pre-existing third
  // SUITE_A_INDEX_EXEMPTIONS entry (its PK (import_id, row_no) is not
  // client_id-leading and needs no CANONICAL_AUTHORITY_KEYS entry either).
  contacts: 'client_id',
  contact_tags: 'client_id',
  contact_tag_links: 'client_id',
  contact_imports: 'client_id',
  contact_import_errors: 'client_id',
  consent_records: 'client_id',
  // P21 (inbound-listener-receipts-and-optout) Unit U1, migration 0063.
  // Surrogate bigint identity PK (not client_id-leading), registered in
  // CANONICAL_AUTHORITY_KEYS below, same class as outbox_events.
  inbound_dead_letters: 'client_id',
  // P23 (broadcast-campaigns) Unit U1, migration 0064. campaign_recipients'
  // unique authority (cr_campaign_target_uq) keys on a globally-unique
  // parent id (coalesce(contact_id, group_id)) - it is the pre-registered
  // fourth SUITE_A_INDEX_EXEMPTIONS entry, not a CANONICAL_AUTHORITY_KEYS
  // registration. campaign_counters' PK is campaign_id (a 1:1 surrogate
  // referencing campaigns(id)), registered in CANONICAL_AUTHORITY_KEYS below,
  // same class as instance_lease_state/instance_pacing_state.
  campaign_recipients: 'client_id',
  campaign_counters: 'client_id',
  // P24 (groups-messaging) Unit U1, migration 0066. Surrogate uuid PK (not
  // client_id-leading), registered in CANONICAL_AUTHORITY_KEYS below, same
  // class as topup_requests/contacts.
  wa_groups: 'client_id',
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070. Surrogate
  // uuid PK (not client_id-leading), registered in CANONICAL_AUTHORITY_KEYS
  // below, same class as topup_requests/contacts. staff_users/staff_sessions
  // are non-tenant (registered in ISOLATION_NON_TENANT_TABLES below instead).
  impersonation_grants: 'client_id',
  // Go-live session, Unit U1, migration 0076. PK (client_id, id) already
  // leads with client_id, so no CANONICAL_AUTHORITY_KEYS entry is needed -
  // its only non-tenant-scoped unique authority (api_keys_key_prefix_uq) is
  // registered in GLOBAL_UNIQUE_INDEXES below instead.
  api_keys: 'client_id',
  // P34 U-upload (ADR 0052 accepted scope), migration 0077. PK (client_id,
  // id) already leads with client_id - no CANONICAL_AUTHORITY_KEYS entry
  // needed. Its second unique index (client_id, sha256) also leads with
  // client_id, so it needs no GLOBAL_UNIQUE_INDEXES/SUITE_A_INDEX_EXEMPTIONS
  // entry either.
  media_assets: 'client_id',
};

/**
 * Tables intentionally OUTSIDE tenant scope - each entry's value is the
 * one-line reason it is exempt, never empty (an empty reason is itself a
 * finding - see `coverage.ts`).
 */
export const ISOLATION_NON_TENANT_TABLES: Readonly<Record<string, string>> = {
  users: 'identity is global; membership is the tenant edge (ADR 0017)',
  plans: 'global plan catalog, staff-owned; no client_id column',
  plan_limits: 'global plan-limit catalog keyed on plan_id, staff-owned',
  price_lists: 'global price catalog; per-tenant pricing lives in client_pricing',
  price_list_items: 'global price catalog line items; no per-tenant override here',
  schema_migrations: 'migration-runner bookkeeping, not application/tenant data',
  // P04a (auth-signup-and-onboarding) additions, migration 0013. The three
  // auth tables key on user_id, not client_id - identity is global, same
  // class as `users` itself (no client_id column at all).
  auth_sessions:
    'user-keyed refresh-token session, no client_id column - same identity-is-global class as users',
  email_verification_tokens:
    'user-keyed, immutable-after-consumption token record, no client_id column - same identity-is-global class as users',
  password_reset_tokens:
    'user-keyed, immutable-after-consumption token record, no client_id column - same identity-is-global class as users',
  // audit_logs DOES carry a client_id column, unlike the three tables above -
  // it is allow-listed here rather than added to TENANT_TABLE_COVERAGE
  // because client_id is intentionally NULLable (NULL = platform-level
  // action, e.g. staff login/impersonation with no owning tenant), which
  // does not fit the coverage registry's client_id-NOT-NULL tenant-table
  // shape (core invariant 4 / database.md). It still carries RLS: ENABLE +
  // FORCE + the standard tenant_isolation policy (migration 0013), so a
  // tenant-context read is still scoped to exactly its own client_id rows -
  // only a BYPASSRLS role (wp_admin_app) ever sees the NULL platform rows.
  audit_logs:
    'client_id is nullable (NULL = platform-level action); still RLS-scoped via the standard tenant_isolation policy, but the NOT-NULL tenant-table registry does not fit a legitimately-NULL tenant key (migration 0013)',
  // P04a Unit UA5b addition, migration 0014.
  mfa_recovery_codes:
    'user-keyed, one-time-use TOTP recovery code record, no client_id column - same identity-is-global class as users/auth_sessions',
  // P13 U1, migration 0030: global staff-owned catalogs, same class as plans/plan_limits.
  pacing_profiles: 'global pacing-profile catalog, staff-owned; no client_id column',
  pacing_warmup_tiers:
    'global warm-up-tier catalog keyed on profile_key, staff-owned; no client_id column',
  // P19 (topup-and-staff-audit) U1, migration 0058. Same audit_logs
  // precedent above: client_id is intentionally NULLable (NULL =
  // platform-level staff action), so this does not fit the NOT-NULL
  // tenant-table registry shape. Still RLS: ENABLE + FORCE + the standard
  // tenant_isolation policy.
  staff_audit_log:
    'client_id is nullable (NULL = platform-level staff action); still RLS-scoped via the standard tenant_isolation policy, same audit_logs precedent (migration 0013)',
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070. Staff belong
  // to WP, not to a client - same identity-is-global class as users.
  staff_users: 'WP staff identity, no client_id column - same identity-is-global class as users',
  staff_sessions:
    'staff-keyed refresh-token session, no client_id column - same identity-is-global class as staff_users/auth_sessions',
  // P29 (website-and-launch-hardening) Unit U4a, migration 0074. The public
  // marketing site posts to a public endpoint on admin/backend that writes
  // this row before any client exists (blueprint [R-52]).
  leads: 'marketing lead, no tenant exists yet',
};

/**
 * Tables whose UNIQUE authorities legitimately key on a globally unique
 * parent id instead of leading with the tenant key (client_id) - exempt from
 * suite A's "leads-with-client_id" rule for their UNIQUE indexes only.
 * EXACTLY these three - a test asserts the count and names. Non-unique
 * indexes on these tables are NOT exempt and must still lead with the
 * tenant key.
 *
 * None of these tables exist yet in P02 (they arrive with broadcast/wallet
 * work in later phases); suite A applies the exemption only to tables that
 * actually exist in the live catalog.
 */
export const SUITE_A_INDEX_EXEMPTIONS = [
  'campaign_recipients',
  'wallet_charge_guards',
  'contact_import_errors',
] as const;

/**
 * SECONDARY unique indexes on a tenant table that legitimately enforce a
 * GLOBAL uniqueness invariant and therefore cannot lead with the tenant key.
 * Index name -> non-empty reason. Anything else that fails the
 * leads-with-client_id rule is a red build, not a candidate for this list.
 *
 * Rule this registry operationalizes: on a tenant table, every PK and every
 * non-unique index leads with the table's tenant-key column; the three
 * `SUITE_A_INDEX_EXEMPTIONS` tables are exempt only for their UNIQUE indexes
 * (their unique authorities key on a globally-unique parent id) - their
 * non-unique indexes are NOT exempt; a global-uniqueness SECONDARY unique
 * index elsewhere is allowed only when named here with a reason.
 */
export const GLOBAL_UNIQUE_INDEXES: Readonly<Record<string, string>> = {
  memberships_one_workspace_per_user_uq:
    'ADR 0017 S5: one workspace per user, enforced at storage - dropping it is the whole teams migration',
  clients_slug_key:
    'workspace slugs are globally unique - subdomain/label semantics (verified against pg_indexes on the dev DB)',
  api_keys_key_prefix_uq:
    'a presenting HTTP request has no tenant context yet - the prefix is the pre-hash global lookup handle (migration 0076)',
};

// CanonicalAuthorityMatch/CanonicalAuthorityKey/CANONICAL_AUTHORITY_KEYS
// moved to ./canonical-authority-keys.js (P13 U1, file-length cap - same
// "move a self-contained registry to a sibling module" idiom SEND_PATH_TABLES
// already established below); re-exported unchanged for existing consumers.
export {
  CANONICAL_AUTHORITY_KEYS,
  type CanonicalAuthorityKey,
  type CanonicalAuthorityMatch,
} from './canonical-authority-keys.js';

// SEND_PATH_TABLES moved to ./send-path-tables.js (P07 U2, file-length cap);
// re-exported from db/src/index.ts unchanged for existing consumers.
export { SEND_PATH_TABLES } from './send-path-tables.js';
