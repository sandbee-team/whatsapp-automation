import type { CanonicalAuthorityKey } from './canonical-authority-keys.js';

/**
 * Split out of `canonical-authority-keys.ts` (P23 U1, to stay under the
 * 300-line file cap - same "move a self-contained registry to a sibling
 * module" idiom that file's own header already established when it split out
 * of `tenant-tables.ts`). Carries every P20-and-later `CANONICAL_AUTHORITY_
 * KEYS` entry; merged back into the main export via object spread so
 * existing consumers (`db/tests/isolation-suite-a.test.ts`) see one
 * unchanged registry shape.
 */
export const CANONICAL_AUTHORITY_KEYS_P20_PLUS: Readonly<
  Record<string, readonly CanonicalAuthorityKey[]>
> = {
  // P20 (contacts-and-import) Unit U1, migration 0060. Four surrogate-uuid
  // PK tables; contact_tag_links' PK already leads with client_id and
  // contact_import_errors is the SUITE_A_INDEX_EXEMPTIONS entry instead.
  contacts: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated surrogate identity PK (same convention as topup_requests/webhook_endpoints) - a row handle only, not a uniqueness authority; the real duplicate-contact authority is contacts_client_phone_uq below (a PARTIAL unique index, WHERE deleted_at IS NULL), which already leads with client_id. The table also carries contacts_client_updated_idx/contacts_client_optout_idx/contacts_client_hash_idx, all client_id-leading secondary indexes.',
    },
  ],
  contact_tags: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated surrogate identity PK (same convention as topup_requests/webhook_endpoints) - a row handle only, not a uniqueness authority; the real per-tenant-unique-name authority is contact_tags_client_id_name_key below, which already leads with client_id.',
    },
  ],
  contact_imports: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated surrogate identity PK (same convention as topup_requests/webhook_endpoints) - a row handle only, not a uniqueness authority; the table also carries contact_imports_client_created_idx, a client_id-leading secondary index for the tenant list/poll route.',
    },
  ],
  consent_records: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated surrogate identity PK (same convention as topup_requests/webhook_endpoints) - a row handle only, not a uniqueness authority; the table is append-only evidence with no secondary uniqueness authority, and also carries consent_records_client_captured_idx, a client_id-leading secondary index for the tenant list route.',
    },
  ],
  // P21 (inbound-listener-receipts-and-optout) Unit U1, migration 0063.
  inbound_dead_letters: [
    {
      match: { kind: 'primary_key' },
      reason:
        'bigint identity surrogate handle only; the row has no uniqueness authority - a dead letter is an event record, replays are allowed by design (ADR 0021). The table also carries inbound_dead_letters_client_idx, a client_id-leading secondary index for the per-tenant/instance recent-dead-letters read.',
    },
  ],
  // P23 (broadcast-campaigns) Unit U1, migration 0064. cr_campaign_target_uq
  // (the UNIQUE authority) is covered by the pre-existing SUITE_A_INDEX_
  // EXEMPTIONS entry for this table (N13: that exemption applies only to
  // UNIQUE indexes) - this entry covers the table's NON-unique secondary
  // index instead, which the exemption does not reach.
  campaign_recipients: [
    {
      match: { kind: 'leading_column', column: 'campaign_id' },
      reason:
        'cr_campaign_cursor_idx is the expansion worker\'s keyset cursor (batches of 500, ordered by id, scoped to one campaign at a time) - campaign_id is the correct leading column for this per-campaign scan, not client_id. cr_client_campaign_status_idx (the table\'s client_id-leading index) already satisfies the "at least one client_id-leading index" rule for this table.',
    },
  ],
  campaign_counters: [
    {
      match: { kind: 'primary_key' },
      reason:
        'PK is campaign_id, a 1:1 surrogate referencing campaigns(id) (one progress-rollup row per campaign) - the table also carries campaign_counters_client_idx, a client_id-leading secondary index. Same precedent as instance_lease_state/instance_pacing_state.',
    },
  ],
  // P24 (groups-messaging) Unit U1, migration 0066.
  wa_groups: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated (DB-defaulted) surrogate identity PK (same convention as topup_requests/contacts) - a row handle only, not a uniqueness authority; the real duplicate-group authority is wa_groups_client_instance_jid_uq below, which already leads with client_id. The table also carries wa_groups_send_enabled_idx, a client_id-leading secondary index for the send-loop\'s "enabled groups for this instance" query.',
    },
    {
      match: { kind: 'leading_column', column: 'instance_id' },
      reason:
        "wa_groups_pending_idx is deliberately global: the worker's pending-leave/due-resync discovery sweep scans across every tenant's instances in one pass, same class as message_jobs_lease_expiry_idx/ils_stale_idx/campaigns_worker_discovery_idx.",
    },
  ],
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
  impersonation_grants: [
    {
      match: { kind: 'primary_key' },
      reason:
        'uuid app-generated (DB-defaulted) surrogate identity PK (same convention as topup_requests/contacts/wa_groups) - a row handle only, not a uniqueness authority; the table also carries impersonation_grants_client_expires_idx, a client_id-leading secondary index for the tenant-scoped "grants against this workspace" read.',
    },
  ],
};
