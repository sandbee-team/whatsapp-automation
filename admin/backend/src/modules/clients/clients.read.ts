import type { AdminReadQueryable } from '../../platform/platform-read.js';
import { decodeCursor, encodeCursor, type KeysetPage } from '../../platform/keyset.js';

/**
 * modules/clients/clients.read.ts (P28 Unit U4, step 7) - the cross-tenant
 * client list + detail reads. Every exported function here is a REGISTERED
 * platform read (`scripts/registries/cross-tenant-queries-p28-admin.ts`,
 * mirrored by `platform/registered-reads.ts`) and is only ever reachable
 * through `platformRead()`, which supplies the `wp_admin_app` role and
 * writes the audit row in the same transaction.
 *
 * PROJECTION DISCIPLINE (binding, pinned by
 * `platform-read.integration.test.ts#admin_projections_contain_no_phone_body_name_or_external_ref`):
 * these projections carry NO `phone_e164`, `owner_jid`, `label`,
 * `full_name`, `email`, `payload`, `external_ref` or `recipient_*` column.
 * `company_name` IS allowed - it is the workspace's business identity, which
 * is precisely what a staff member needs to act on a support ticket, and it
 * is not a natural person's PII. Everything else staff need is an id, an
 * enum, a count or a paise amount. This is why an impersonation grant (with
 * its own time box and audit trail) exists: reading a tenant's actual
 * message content is a separate, elevated, expiring decision - never a
 * side effect of opening the client list.
 *
 * PAGINATION: keyset only (`(created_at, id) < (cursor)`), never `OFFSET` -
 * the eslint `wp/no-offset-pagination` rule and
 * `clients.read.integration.test.ts#admin_reads_are_keyset_paginated_and_never_use_offset`
 * both enforce it. A staff list walked with OFFSET over a moving table skips
 * and duplicates rows, which for an audit-facing surface is a correctness
 * problem, not a cosmetic one.
 */

export interface ClientListItem {
  id: string;
  companyName: string;
  slug: string;
  status: string;
  onboardingStep: string;
  planKey: string | null;
  createdAt: string;
  instanceCount: number;
  connectedCount: number;
  walletState: string | null;
  /** PAISE, as a decimal STRING - never a JS number (a rupee balance past 2^53 paise would silently lose precision). */
  balanceMinor: string | null;
}

export interface ListClientsFilter {
  status?: string;
  /** Substring match against `company_name`/`slug` only - never against any user's name or email. */
  q?: string;
  limit: number;
  cursor?: string;
}

const LIST_CLIENTS_SQL = `SELECT c.id,
         c.company_name,
         c.slug::text AS slug,
         c.status::text AS status,
         c.onboarding_step::text AS onboarding_step,
         p.key AS plan_key,
         c.created_at,
         (SELECT count(*)::int FROM whatsapp_instances i
           WHERE i.client_id = c.id AND i.deleted_at IS NULL) AS instance_count,
         (SELECT count(*)::int FROM whatsapp_instances i
           WHERE i.client_id = c.id AND i.deleted_at IS NULL
             AND i.health_state = 'connected') AS connected_count,
         w.state::text AS wallet_state,
         w.balance_minor::text AS balance_minor
    FROM clients c
    LEFT JOIN plans p ON p.id = c.plan_id
    LEFT JOIN wallet_accounts w ON w.client_id = c.id
   WHERE c.deleted_at IS NULL
     AND ($1::text IS NULL OR c.status::text = $1)
     AND ($2::text IS NULL OR c.company_name ILIKE '%' || $2 || '%' OR c.slug::text ILIKE '%' || $2 || '%')
     AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3, $4::uuid))
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT $5`;

interface RawClientRow extends Record<string, unknown> {
  id: string;
  company_name: string;
  slug: string;
  status: string;
  onboarding_step: string;
  plan_key: string | null;
  created_at: Date;
  instance_count: number;
  connected_count: number;
  wallet_state: string | null;
  balance_minor: string | null;
}

function mapClientRow(row: RawClientRow): ClientListItem {
  return {
    id: row.id,
    companyName: row.company_name,
    slug: row.slug,
    status: row.status,
    onboardingStep: row.onboarding_step,
    planKey: row.plan_key,
    createdAt: row.created_at.toISOString(),
    instanceCount: row.instance_count,
    connectedCount: row.connected_count,
    walletState: row.wallet_state,
    balanceMinor: row.balance_minor,
  };
}

/** Keyset-paginated cross-tenant client list - see the module header's projection/pagination discipline. */
export async function listClients(
  db: AdminReadQueryable,
  filter: ListClientsFilter,
): Promise<KeysetPage<ClientListItem>> {
  const cursor = decodeCursor(filter.cursor);
  const result = await db.query<RawClientRow>(LIST_CLIENTS_SQL, [
    filter.status ?? null,
    filter.q ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    filter.limit,
  ]);
  const items = result.rows.map(mapClientRow);
  const last = result.rows[result.rows.length - 1];
  return {
    items,
    nextCursor:
      result.rows.length === filter.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

export interface ClientDetail {
  id: string;
  companyName: string;
  slug: string;
  status: string;
  onboardingStep: string;
  planKey: string | null;
  planName: string | null;
  createdAt: string;
  timezone: string;
}

const READ_CLIENT_SQL = `SELECT c.id,
         c.company_name,
         c.slug::text AS slug,
         c.status::text AS status,
         c.onboarding_step::text AS onboarding_step,
         c.timezone,
         c.created_at,
         p.key AS plan_key,
         p.name AS plan_name
    FROM clients c
    LEFT JOIN plans p ON p.id = c.plan_id
   WHERE c.id = $1 AND c.deleted_at IS NULL`;

interface RawClientDetailRow extends Record<string, unknown> {
  id: string;
  company_name: string;
  slug: string;
  status: string;
  onboarding_step: string;
  timezone: string;
  created_at: Date;
  plan_key: string | null;
  plan_name: string | null;
}

/** ONE client's own row by primary key (the detail header) - `undefined` when no live client has that id. */
export async function readClient(
  db: AdminReadQueryable,
  clientId: string,
): Promise<ClientDetail | undefined> {
  const result = await db.query<RawClientDetailRow>(READ_CLIENT_SQL, [clientId]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    companyName: row.company_name,
    slug: row.slug,
    status: row.status,
    onboardingStep: row.onboarding_step,
    planKey: row.plan_key,
    planName: row.plan_name,
    createdAt: row.created_at.toISOString(),
    timezone: row.timezone,
  };
}
