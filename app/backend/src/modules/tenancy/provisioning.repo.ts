import { bindQueryParams, loadQuery, type TenantQueryable } from '@wp/db';

/**
 * provisioning.repo.ts (P04a Unit A3) - SQL ONLY, no business `if`s, no
 * provider calls. Every function runs a single statement against `sql` (the
 * caller's own transaction handle - `@wp/db`'s `TenantQueryable`). Orchestration
 * (the slug-retry-once decision, the "max_rate_minor must not be null/zero"
 * decision, error-code mapping) lives in modules/identity/signup.service.ts.
 *
 * Every INSERT below carries a trailing `-- client_id = $n` comment even
 * though it is also structurally obvious from the column list: check-tenant-
 * scope.ts's tenant-isolation scanner (core invariant 4) is a literal-text
 * heuristic keyed on the substring `client_id\s*=`, which an INSERT's
 * `(client_id, ...) VALUES (...)` column-list shape does not itself contain -
 * the comment is what keeps the scanner's proof honest without weakening it
 * (see scripts/check-tenant-scope.ts's own doc comment).
 */

export interface InsertClientInput {
  id: string;
  companyName: string;
  slug: string;
  ownerUserId: string;
  /** P28 U5 (item 3): resolved via `readDefaultPlanId` in the SAME transaction - never left NULL (core invariant 2: no zero-capacity workspace). */
  planId: string;
}

/** Inserts one `clients` row. Throws the raw driver error on conflict (e.g. `clients_slug_key`). */
export async function insertClient(sql: TenantQueryable, input: InsertClientInput): Promise<void> {
  await sql.query(
    `INSERT INTO clients (id, company_name, slug, owner_user_id, plan_id)
     VALUES ($1, $2, $3, $4, $5)
     -- client_id = id = $1 (clients' tenant_isolation policy keys on "id" - migration 0005)
    `,
    [input.id, input.companyName, input.slug, input.ownerUserId, input.planId],
  );
}

/**
 * Reads the id of the ONE `plans` row with `is_default = true` (migration
 * 0070's `plans_one_default_uq` partial unique index guarantees at most one
 * exists). Returns `null` when none exists - the caller (signup.service.ts)
 * treats that as fatal (`NoDefaultPlanError`), never silently proceeding
 * with a NULL `plan_id` (core invariant 2: no zero-capacity workspace).
 */
export async function readDefaultPlanId(sql: TenantQueryable): Promise<string | null> {
  const result = await sql.query<{ id: string }>(`SELECT id FROM plans WHERE is_default LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

export interface InsertMembershipInput {
  clientId: string;
  userId: string;
  role: string;
}

/** Inserts one `memberships` row. Throws the raw driver error on conflict (e.g. `memberships_one_workspace_per_user_uq`). */
export async function insertMembership(
  sql: TenantQueryable,
  input: InsertMembershipInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO memberships (client_id, user_id, role)
     VALUES ($1, $2, $3)
     -- client_id = $1`,
    [input.clientId, input.userId, input.role],
  );
}

/**
 * Reads `max(rate_minor)` for `priceListKey` from the global price catalog.
 * Returns `null` when the key has no rows (missing/renamed price list) -
 * never throws for "not found"; the caller decides whether that is fatal.
 */
export async function getMaxRateMinor(
  sql: TenantQueryable,
  priceListKey: string,
): Promise<number | null> {
  const result = await sql.query<{ max_rate_minor: number | string | null }>(
    `SELECT max(rate_minor) AS max_rate_minor
       FROM price_list_items
      WHERE price_list_key = $1`,
    [priceListKey],
  );
  const raw = result.rows[0]?.max_rate_minor ?? null;
  return raw === null ? null : Number(raw);
}

export interface InsertWalletAccountInput {
  clientId: string;
  currency: string;
  balanceMinor: number;
  lowBalanceThresholdMinor: number;
  maxRateMinor: number;
  entrySeq: number;
  lifetimeCreditMinor: number;
  lifetimeDebitMinor: number;
}

/** Inserts one `wallet_accounts` row. */
export async function insertWalletAccount(
  sql: TenantQueryable,
  input: InsertWalletAccountInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO wallet_accounts
       (client_id, currency, balance_minor, low_balance_threshold_minor, max_rate_minor,
        entry_seq, lifetime_credit_minor, lifetime_debit_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     -- client_id = $1
    `,
    [
      input.clientId,
      input.currency,
      input.balanceMinor,
      input.lowBalanceThresholdMinor,
      input.maxRateMinor,
      input.entrySeq,
      input.lifetimeCreditMinor,
      input.lifetimeDebitMinor,
    ],
  );
}

export interface InsertClientPricingInput {
  clientId: string;
  priceListKey: string;
  overrideItems?: Record<string, unknown>;
}

/** Inserts one `client_pricing` row. */
export async function insertClientPricing(
  sql: TenantQueryable,
  input: InsertClientPricingInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO client_pricing (client_id, price_list_key, override_items)
     VALUES ($1, $2, $3)
     -- client_id = $1
    `,
    [input.clientId, input.priceListKey, JSON.stringify(input.overrideItems ?? {})],
  );
}

export interface InsertWalletLedgerEntryInput {
  clientId: string;
  seq: number;
  kind: string;
  amountMinor: number;
  balanceAfterMinor: number;
  quantity?: number;
  actorType: string;
  actorUserId?: string | null;
  externalRef: string;
}

/**
 * Inserts one `wallet_ledger` row (append-only - never UPDATEd/DELETEd).
 * Loads `db/queries/wallet-signup-credit.sql` - the one sanctioned
 * non-send ledger writer (`scripts/check-single-debit.ts`'s exempt-path
 * list; see that file's own header).
 */
export async function insertWalletLedgerEntry(
  sql: TenantQueryable,
  input: InsertWalletLedgerEntryInput,
): Promise<void> {
  const q = await loadQuery('wallet-signup-credit');
  await sql.query(
    q.text,
    bindQueryParams(q, {
      client_id: input.clientId,
      seq: input.seq,
      kind: input.kind,
      amount_minor: input.amountMinor,
      balance_after_minor: input.balanceAfterMinor,
      quantity: input.quantity ?? 1,
      actor_type: input.actorType,
      actor_user_id: input.actorUserId ?? null,
      external_ref: input.externalRef,
    }),
  );
}

export interface InsertWalletLedgerExtRefInput {
  clientId: string;
  externalRef: string;
  seq: number;
}

/** Inserts one `wallet_ledger_ext_refs` row - the global external_ref idempotency authority. */
export async function insertWalletLedgerExtRef(
  sql: TenantQueryable,
  input: InsertWalletLedgerExtRefInput,
): Promise<void> {
  await sql.query(
    `INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq)
     VALUES ($1, $2, $3)
     -- client_id = $1
    `,
    [input.clientId, input.externalRef, input.seq],
  );
}

/**
 * FIX 8 (P04a FIXA C1 review): migration 0013's `audit_logs.metadata`
 * comment claims "allow-listed keys only, enforced app-side" - this is that
 * enforcement. Unknown keys are DROPPED, never thrown (an audit write must
 * never fail the caller's transaction just because it was handed an
 * unexpected metadata key) - grow this set deliberately as new audit
 * actions need specific metadata (a count/flag/id, NEVER PII), never widen
 * it to "everything". `sessionsRevoked` (P28 U5, item 1): the count of
 * OTHER `auth_sessions` rows `auth.password.change` revoked. `tos_version`
 * (P29a step 10): the ToS version string recorded on the
 * `onboarding.consent_attested` row - snake_case (unlike this set's other,
 * camelCase keys) because it is a durable audit-record field name, not a
 * request/response shape, and is queried directly as `metadata->>'tos_version'`.
 */
export const ALLOWED_AUDIT_METADATA_KEYS = new Set<string>([
  'reason',
  'source',
  'code',
  'acknowledgement',
  'count',
  'trackedDevicesEnabledTotal',
  'groupTrackedDevices',
  'sessionsRevoked',
  'tos_version',
]);

/** Drops any key not in `ALLOWED_AUDIT_METADATA_KEYS` - see its doc comment. Returns `null` for an empty/absent result. */
export function filterAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (ALLOWED_AUDIT_METADATA_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}

export interface InsertAuditLogInput {
  clientId: string;
  actorType: string;
  actorUserId?: string | null;
  /**
   * P28 U3b: the acting `staff_users.id` for an `actor_type = 'staff'` row -
   * the column has existed since migration 0013 (with its own partial index)
   * but had no TS writer until the `/internal/v1` staff mutations needed to
   * attribute a tenant-visible `audit_logs` row (instance resume, campaign
   * cancel) to a named staff member rather than to a tenant user. A staff
   * row carries `actor_staff_id` and leaves `actor_user_id` NULL; a tenant
   * row is unchanged.
   */
  actorStaffId?: string | null;
  /**
   * P28 U3c: set on the `impersonation.token_refreshed` row only - the staff
   * member whose grant the refreshed token traces back to. Distinct from
   * `actorStaffId` in principle (a future actor kind could refresh a token
   * on a staff member's behalf); today's one caller sets both to the same
   * `grant.staffId`.
   */
  impersonatedByStaffId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Inserts one `audit_logs` row (append-only, monthly-partitioned parent). */
export async function insertAuditLog(
  sql: TenantQueryable,
  input: InsertAuditLogInput,
): Promise<void> {
  const metadata = filterAuditMetadata(input.metadata);
  await sql.query(
    `INSERT INTO audit_logs
       (client_id, actor_type, actor_user_id, actor_staff_id, impersonated_by_staff_id,
        action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.clientId,
      input.actorType,
      input.actorUserId ?? null,
      input.actorStaffId ?? null,
      input.impersonatedByStaffId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}
