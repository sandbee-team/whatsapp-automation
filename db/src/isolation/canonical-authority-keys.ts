import { CANONICAL_AUTHORITY_KEYS_P20_PLUS } from './canonical-authority-keys-p20-plus.js';

/**
 * Split out of `tenant-tables.ts` (P13 U1, to stay under the 300-line file
 * cap - same "move a self-contained registry to a sibling module" idiom
 * `send-path-tables.ts` already established for `SEND_PATH_TABLES`, P07 U2).
 * Same registry, same consumers (`db/tests/isolation-suite-a.test.ts`'s
 * `every_tenant_index_leads_with_client_id_except_the_three_named_exemptions`
 * case); re-exported unchanged from `tenant-tables.ts` for existing callers.
 * Every P20-and-later entry lives in the `canonical-authority-keys-p20-plus.js`
 * sibling (same cap, same split idiom) and is merged back in below.
 */

/**
 * Describes an INTENTIONAL index shape on a `TENANT_TABLE_COVERAGE` table
 * (never one of the three `SUITE_A_INDEX_EXEMPTIONS` tables - those are
 * handled separately) whose leading column is legitimately not the tenant
 * key.
 *
 * `match` describes how a live `pg_index` row is recognized:
 *  - `{ kind: 'primary_key' }` matches ANY primary-key index on the table (by
 *    `indisprimary`, not by name). Required for the two monthly/weekly
 *    partitioned tables (`message_jobs`/`delivery_events`): every partition's
 *    PK index gets its own auto-generated name that rolls forward every
 *    month/week and can never be enumerated as literals.
 *  - `{ kind: 'named', indexName }` matches one exact, stable index name -
 *    only safe on a non-partitioned table where Postgres names the index
 *    once and it never changes (e.g. `send_attempts`' UNIQUE constraint).
 *  - `{ kind: 'leading_column', column }` matches any NON-primary index on
 *    the table whose first key column is `column`, regardless of name - the
 *    same "name rolls forward per partition" problem applies to
 *    `message_jobs_lease_expiry_idx`'s per-partition children.
 */
export type CanonicalAuthorityMatch =
  | { kind: 'primary_key' }
  | { kind: 'named'; indexName: string }
  | { kind: 'leading_column'; column: string };

export interface CanonicalAuthorityKey {
  match: CanonicalAuthorityMatch;
  /** One-line reason this shape is canon, never empty. */
  reason: string;
}

/**
 * Table -> the canonical (intentionally non-client_id-leading) index shapes
 * on it. Verified against the live catalog (`pg_index`/`pg_class`) on the dev
 * DB while writing this registry - see the P03 Unit C session report for the
 * exact query.
 */
export const CANONICAL_AUTHORITY_KEYS: Readonly<Record<string, readonly CanonicalAuthorityKey[]>> =
  {
    message_jobs: [
      {
        match: { kind: 'primary_key' },
        reason:
          'message_jobs is RANGE-partitioned by created_at; a unique index on a partitioned table can only be enforced per-partition unless it carries the partition key, so the PK is (id, created_at), not client_id-leading (migration 0007, schema-assertions test 21).',
      },
      {
        match: { kind: 'leading_column', column: 'lease_expires_at' },
        reason:
          'message_jobs_lease_expiry_idx is deliberately global: the lease-expiry sweeper reclaims stale "processing" leases across every tenant/instance in one pass (migration 0007 comment) - a client_id-leading index would defeat the sweep.',
      },
    ],
    delivery_events: [
      {
        match: { kind: 'primary_key' },
        reason:
          'delivery_events is RANGE-partitioned weekly by created_at; the PK must carry the partition key, so it is (id, created_at), not client_id-leading (migration 0009, test 21). The dedupe authority is delivery_event_ids, not a unique index here.',
      },
    ],
    message_job_refs: [
      {
        match: { kind: 'primary_key' },
        reason:
          'public_id is the single externally-visible id for a message job (the idempotency/dedupe reference tuple used everywhere else) - a globally-unique app-generated uuidv7 surrogate by design, not tenant-scoped (migration 0008). Its secondary unique indexes (mjr_idem_uq/mjr_dedupe_uq) already lead with client_id.',
      },
    ],
    delivery_event_ids: [
      {
        match: { kind: 'primary_key' },
        reason:
          'provider_event_id is the mandatory webhook/provider-event dedupe authority (database.md: unique constraints for provider_event_id are mandatory) - a provider event id is globally unique by definition, so it must be the PK, not client_id-leading (migration 0008).',
      },
    ],
    send_attempts: [
      {
        match: { kind: 'primary_key' },
        reason:
          'surrogate bigint identity PK - a row handle only, not a uniqueness authority; the real attempt-uniqueness authority is the UNIQUE(message_job_id, attempt_no) constraint below (migration 0008).',
      },
      {
        match: { kind: 'named', indexName: 'send_attempts_message_job_id_attempt_no_key' },
        reason:
          'UNIQUE(message_job_id, attempt_no) is the canon-mandated real-uniqueness authority for attempt numbering (queue-engineering canon: record the send attempt before calling the provider, keyed on the job it belongs to) - message_job_id, not client_id, is the correct leading column for this authority.',
      },
      {
        match: { kind: 'leading_column', column: 'instance_id' },
        reason:
          'send_attempts_content_hash_idx is a per-instance content-hash dedupe lookback for the send worker (migration 0008) - instance_id is already a tenant-scoped 1:1 handle via whatsapp_instances, so an instance-leading index is the correct shape for this lookback, not a cross-tenant leak.',
      },
      {
        match: { kind: 'leading_column', column: 'message_job_id' },
        reason:
          'send_attempts_job_lease_idx is the attempt-trail lookup by (job, lease) for the reconcile/audit path (migration 0008) - it is keyed on the job it belongs to, which is itself tenant-scoped at creation.',
      },
    ],
    whatsapp_instances: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuidv7 app-generated surrogate identity PK (migration 0002 id convention) - the table also carries whatsapp_instances_client_idx, a client_id-leading secondary index for the "list this client\'s instances" query.',
      },
    ],
    instance_lease_state: [
      {
        match: { kind: 'primary_key' },
        reason:
          'PK is instance_id, a 1:1 foreign-id surrogate referencing whatsapp_instances(id) - the table also carries instance_lease_state_client_idx, a client_id-leading secondary index.',
      },
      {
        match: { kind: 'leading_column', column: 'lease_seen_at' },
        reason:
          'ils_stale_idx is deliberately global: the unowned-instance discovery sweep scans stale lease liveness across every tenant in one pass (ADR 0029; same class as message_jobs_lease_expiry_idx, migration 0018).',
      },
    ],
    campaigns: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuidv7 app-generated surrogate identity PK - the table also carries campaigns_client_idx, a client_id-leading secondary index for the "list this client\'s campaigns" query.',
      },
      {
        match: { kind: 'leading_column', column: 'status' },
        reason:
          'campaigns_worker_discovery_idx (migration 0064, P23 U1) is deliberately global: the snapshot/expansion cron sweeps discover due campaigns across every tenant in one pass, same class as message_jobs_lease_expiry_idx/ils_stale_idx/outbox_events_unpublished_idx.',
      },
      {
        match: { kind: 'named', indexName: 'campaigns_funnel_discovery_idx' },
        reason:
          'campaigns_funnel_discovery_idx (migration 0065, P23a C1 fix Unit F1; narrowed to the NAMED index at the re-review so no future campaigns (id, ...) index inherits this exemption) is deliberately global: the 5s active-campaign funnel sweep rotates by keyset (status IN (...) AND id > $cursor ORDER BY id) across every tenant in one pass, same class as campaigns_worker_discovery_idx above.',
      },
    ],
    // P07 (session-auth-store) U2, migration 0020: both PKs lead with
    // instance_id (fence-protocol authority, ADR 0029), not client_id; tenant
    // scoping is RLS + query predicates, same precedent as instance_lease_state.
    whatsapp_session_credentials: [
      {
        match: { kind: 'primary_key' },
        reason:
          'PK is instance_id, a 1:1 surrogate referencing whatsapp_instances(id) - fence-protocol authority (owner_fence); client scoping is RLS + query predicates, not PK shape (precedent ADR 0029 / instance_lease_state, migration 0020).',
      },
    ],
    whatsapp_session_keys: [
      {
        match: { kind: 'primary_key' },
        reason:
          'PK is (instance_id, key_type, key_id) - fence-protocol authority (owner_fence), one row per durable Signal key; client scoping is RLS + query predicates, not PK shape (precedent ADR 0029 / instance_lease_state, migration 0020).',
      },
    ],
    // message_wa_ids needs no entry: its PK (client_id, instance_id, direction,
    // wa_msg_id) already leads with client_id.
    // P13 (pacing-and-warmup) U1, migration 0030.
    pacing_ledger: [
      {
        match: { kind: 'primary_key' },
        reason:
          "PK is (instance_id, ledger_date), the reserve statement's own ON CONFLICT target - a client_id-leading PK would break that target. Scoping is RLS + client_id + query predicates, precedent instance_lease_state/whatsapp_session_credentials.",
      },
    ],
    instance_pacing_state: [
      {
        match: { kind: 'primary_key' },
        reason:
          'PK is instance_id, a 1:1 surrogate referencing whatsapp_instances(id) (one pacing-state row per instance) - the table also carries instance_pacing_state_client_idx, a client_id-leading secondary index. Same precedent as instance_lease_state/whatsapp_session_credentials.',
      },
      {
        match: { kind: 'leading_column', column: 'eval_due_at' },
        reason:
          'instance_pacing_state_eval_due_idx (migration 0044) is deliberately global: the health evaluator scans every instance whose eval_due_at has passed in one pass, same class as message_jobs_lease_expiry_idx/ils_stale_idx/outbox_events_unpublished_idx.',
      },
    ],
    pacing_events: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuidv7 app-generated surrogate identity PK - a row handle only, not a uniqueness authority; the table also carries pacing_events_timeline_idx, a client_id-leading secondary index for the panel timeline query.',
      },
    ],
    instance_pacing_overrides: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuidv7 app-generated surrogate identity PK - a row handle only, not a uniqueness authority; the table also carries instance_pacing_overrides_active_idx, a client_id-leading secondary index for the "active overrides for this instance" lookup.',
      },
    ],
    // P14 (safe-mode-guards) U1, migration 0036.
    opt_outs: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuid app-generated surrogate identity PK (canonical safe-mode design SS6.2 DDL, verbatim) - a row handle only, not a uniqueness authority; the real "currently opted out" lookup authority is opt_outs_lookup, the client_id-leading partial unique index.',
      },
    ],
    // P15 (outbox-relay-and-webhooks) Unit U1, migration 0041.
    outbox_events: [
      {
        match: { kind: 'primary_key' },
        reason:
          'bigint GENERATED ALWAYS AS IDENTITY surrogate PK - a row handle only, not a uniqueness authority; the table also carries outbox_events_client_created_idx, a client_id-leading secondary index for the per-tenant browse query.',
      },
      {
        match: { kind: 'leading_column', column: 'id' },
        reason:
          'outbox_events_unpublished_idx is deliberately global: the relay claims unpublished rows across every tenant in one pass (migration 0041 comment) - a client_id-leading index would defeat the cross-tenant claim, same class as message_jobs_lease_expiry_idx.',
      },
    ],
    webhook_endpoints: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuid app-generated surrogate identity PK (same convention as whatsapp_instances/campaigns/pacing_events) - the table also carries webhook_endpoints_client_idx, a client_id-leading secondary index for the "list this client\'s endpoints" query.',
      },
    ],
    webhook_deliveries: [
      {
        match: { kind: 'primary_key' },
        reason:
          'bigint GENERATED ALWAYS AS IDENTITY surrogate PK - a row handle only, not a uniqueness authority; the real uniqueness authority is UNIQUE(outbox_event_id, endpoint_id) below. The table also carries webhook_deliveries_client_created_idx, a client_id-leading secondary index.',
      },
      {
        match: { kind: 'named', indexName: 'webhook_deliveries_outbox_event_id_endpoint_id_key' },
        reason:
          'UNIQUE(outbox_event_id, endpoint_id) is the durable dispatcher-state authority - one delivery row per (event, subscribed endpoint) pair, ever, updated in place across retries (migration 0041) - outbox_event_id is the correct leading column for this authority, not client_id.',
      },
      {
        match: { kind: 'leading_column', column: 'status' },
        reason:
          'webhook_deliveries_claim_idx is deliberately global: the dispatcher claims due pending rows across every tenant in one pass (migration 0041 comment), same class as message_jobs_lease_expiry_idx/outbox_events_unpublished_idx.',
      },
    ],
    // P16 (health-signals-and-pause) Unit A, migration 0044.
    instance_health_samples: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuid app-generated surrogate identity PK (same convention as pacing_events/webhook_endpoints) - a row handle only, not a uniqueness authority; the table also carries instance_health_samples_timeline_idx, a client_id-leading secondary index for the panel sparkline query.',
      },
    ],
    // P17 (notifications-and-instance-card) Unit U1, migration 0048.
    notifications: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuid app-generated surrogate identity PK (same convention as instance_health_samples/webhook_endpoints) - a row handle only, not a uniqueness authority; the real dedupe authority is UNIQUE(client_id, dedupe_key) below, which already leads with client_id. The table also carries notifications_unread_idx and notifications_list_idx, both client_id-leading secondary indexes.',
      },
    ],
    // P19 (topup-and-staff-audit) Unit U1, migration 0058.
    topup_requests: [
      {
        match: { kind: 'primary_key' },
        reason:
          'uuid app-generated surrogate identity PK (same convention as whatsapp_instances/campaigns/webhook_endpoints - a stable public id for the review route) - a row handle only, not a uniqueness authority; the real duplicate-submit authority is UNIQUE(client_id, external_ref) below, which already leads with client_id. The table also carries topup_requests_client_status_idx, a client_id-leading secondary index for the tenant list route.',
      },
    ],
    ...CANONICAL_AUTHORITY_KEYS_P20_PLUS,
  };
