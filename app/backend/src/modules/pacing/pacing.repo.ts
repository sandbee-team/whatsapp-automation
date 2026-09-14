import { bindQueryParams, loadQuery } from '@wp/db';
import type { DenyReason } from '@wp/domain';

/**
 * modules/pacing/pacing.repo.ts (P13 Unit U4) - the thin repo layer over
 * the canonical pacing statements (`db/queries/reserve-pacing.sql`,
 * `db/queries/pacing-deny-reason.sql`, `db/queries/release-pacing.sql`,
 * `db/queries/pacing-ensure-ledger-row.sql`,
 * `db/queries/pacing-ensure-daily-usage-row.sql`). No ORM
 * re-implementation, no alternative predicate - same discipline as
 * `modules/queue/queue.repo.ts`: this module executes the loaded statement
 * and maps its RETURNING row, nothing else. Every `eff_*`/counter predicate
 * lives inside the SQL text itself.
 *
 * `engine/pacing/index.ts` (`reserve()`/`release()`) is the ONE caller of
 * this module - it owns the "which transaction" and "how to resolve a deny
 * reason into a concrete `next_attempt_at`" concerns; this file owns only
 * "run the statement, map the row".
 *
 * FINDING 2 FIX (P13 C1 review): this module used to carry its own private
 * `loadQueryStrippingComments` + cache, duplicating `db/src/queries.ts#
 * loadQuery` because that shared loader's `convertNamedParams` was
 * comment-UNAWARE and mis-parsed `reserve-pacing.sql`'s own header prose
 * (the literal example text `` `$name` ``) as a spurious bind parameter.
 * The shared loader is now itself comment/string-literal-aware (see its own
 * doc comment) - this module uses it directly, same as every other repo in
 * the codebase, so there is exactly ONE query-loading code path over
 * `db/queries/**`, never two that can drift.
 */

/** Minimal query surface - structurally compatible with `pg.Pool`/`pg.Client`/`pg.PoolClient`/`TenantQueryable`, same pattern as `queue.repo.ts`'s `QueueQueryable`. */
export interface PacingQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface ReservePacingInput {
  clientId: string;
  instanceId: string;
  isNewConversation: boolean;
  gapMs: number;
  isGroup: boolean;
  /** `reserve-pacing.sql`'s `$is_exempt` (P14 Unit U4) - bound from `isExemptOrigin(sendOrigin)` by the caller (`engine/pacing/index.ts#reserve`). */
  isExempt: boolean;
}

export interface ReservePacingRow {
  consumedCount: number;
  sentThisHour: number;
  newConvCount: number;
  groupSentCount: number;
  nextEligibleAt: Date;
  ledgerDate: string;
}

interface ReservePacingSqlRow extends Record<string, unknown> {
  consumed_count: number;
  sent_this_hour: number;
  new_conv_count: number;
  group_sent_count: number;
  next_eligible_at: Date;
  /** Runtime type is actually `Date`, not `string` (see `formatPgDate`'s own doc comment) - typed as the SQL column's nominal type here; `reservePacing` converts it with `formatPgDate` before returning. */
  ledger_date: Date;
}

/**
 * `node-postgres`'s default parser for a `date`-typed column (OID 1082)
 * returns a JS `Date` constructed at MACHINE-LOCAL midnight for that
 * calendar date (`new Date(year, month - 1, day)`), never a UTC-midnight
 * `Date` - verified live (`now()::date` on this box round-trips as
 * `2026-08-31T18:30:00.000Z` for the calendar date 2026-09-01, an IST
 * (+05:30) artefact of the developer machine's OWN timezone, not of the
 * SQL or the server). Calling `.toISOString().slice(0, 10)` on that value
 * silently launders a WRONG calendar date whenever the machine's local UTC
 * offset is non-zero - exactly the class of bug this module's callers
 * (`message_jobs.pacing_ledger_date`, `release-pacing.sql`'s `$ledger_date`
 * bind) must never reproduce. `formatPgDate` reads the `Date`'s own LOCAL
 * getters (`getFullYear`/`getMonth`/`getDate` - which parser already used
 * to construct it) rather than any UTC accessor, recovering the exact
 * calendar date Postgres sent, independent of the running process's own
 * timezone.
 */
function formatPgDate(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Runs `reserve-pacing.sql`. Zero rows (deny) resolves to `undefined` - never an error; that is a normal outcome the caller must follow up with `denyReason`. */
export async function reservePacing(
  sql: PacingQueryable,
  input: ReservePacingInput,
): Promise<ReservePacingRow | undefined> {
  const query = await loadQuery('reserve-pacing');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    is_new_conversation: input.isNewConversation,
    gap_ms: input.gapMs,
    is_group: input.isGroup,
    is_exempt: input.isExempt,
  });
  const result = await sql.query<ReservePacingSqlRow>(query.text, params);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    consumedCount: row.consumed_count,
    sentThisHour: row.sent_this_hour,
    newConvCount: row.new_conv_count,
    groupSentCount: row.group_sent_count,
    nextEligibleAt: row.next_eligible_at,
    ledgerDate: formatPgDate(row.ledger_date),
  };
}

export interface DenyReasonInput {
  clientId: string;
  instanceId: string;
  isNewConversation: boolean;
  isGroup: boolean;
  /** `pacing-deny-reason.sql`'s `$is_exempt` (Finding 6, P14 review-fix F2) - MUST equal the original reserve attempt's own `isExempt` (`isExemptOrigin(sendOrigin)`), never re-derived; selects the exempt ladder (window, then plan cap only). */
  isExempt: boolean;
}

export interface DenyReasonRow {
  reason: DenyReason;
  retryAt: Date;
}

interface DenyReasonSqlRow extends Record<string, unknown> {
  reason: DenyReason;
  retry_at: Date;
}

/** Runs `pacing-deny-reason.sql`. Always exactly one row (`NO_LEDGER_ROW`/`UNKNOWN` are themselves reasons) - never special-cases an empty result. */
export async function pacingDenyReason(
  sql: PacingQueryable,
  input: DenyReasonInput,
): Promise<DenyReasonRow> {
  const query = await loadQuery('pacing-deny-reason');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    is_new_conversation: input.isNewConversation,
    is_group: input.isGroup,
    is_exempt: input.isExempt,
  });
  const result = await sql.query<DenyReasonSqlRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    // pacing-deny-reason.sql always returns exactly one row (see its own
    // header) - an empty result here means the statement itself is broken,
    // never a legitimate outcome. Fail closed rather than guess a reason.
    throw new Error(
      'pacingDenyReason: pacing-deny-reason.sql returned zero rows (expected exactly one)',
    );
  }
  return { reason: row.reason, retryAt: row.retry_at };
}

export interface ReleasePacingInput {
  clientId: string;
  instanceId: string;
  ledgerDate: string;
  messageJobId: string;
  isNewConversation: boolean;
  isGroup: boolean;
  /** `release-pacing.sql`'s `$is_exempt` (Finding 9, P14 review-fix F2) - MUST equal the original reserve's own `isExempt` bind value, never re-derived. Selects the exempt refund branch (decrement `system_count`, leave `next_eligible_at` untouched) vs. the non-exempt branch (decrement `consumed_count`/`new_conv_count`/`group_sent_count`, restore `next_eligible_at`). */
  isExempt: boolean;
  gapMs: number;
}

export interface ReleasePacingRow {
  consumedCount: number;
  sentThisHour: number;
  newConvCount: number;
  groupSentCount: number;
  nextEligibleAt: Date;
  refundCount: number;
}

interface ReleasePacingSqlRow extends Record<string, unknown> {
  consumed_count: number;
  sent_this_hour: number;
  new_conv_count: number;
  group_sent_count: number;
  next_eligible_at: Date;
  refund_count: number;
}

/**
 * Runs `release-pacing.sql`. Zero rows (already refunded, or never
 * reserved) resolves to `undefined` - a normal, idempotent no-op, never an
 * error.
 *
 * `is_new_conversation`/`is_group` are bound as `0`/`1` (numbers), NOT `false`/
 * `true` (booleans) - verified live: in THIS file, both parameters appear
 * ONLY inside a `($param)::int` cast (unlike `reserve-pacing.sql`, where
 * `$is_new_conversation` is ALSO used bare in a boolean context, forcing
 * `bool` inference). With no other usage site to hint the parameter's type,
 * Postgres's extended-query-protocol planner infers `$3`/`$4` as `integer`
 * directly (the cast target) rather than `boolean` - the driver then
 * serializes a JS `false`/`true` as the literal text `"false"`/`"true"`,
 * which Postgres rejects as `invalid input syntax for type integer`. `0`/`1`
 * bind correctly under either inferred type. `db/queries/release-pacing.sql`
 * is outside this unit's file scope to edit; this is a caller-side
 * workaround for a real parameter-type-inference gap in that landed file,
 * never a semantic change (`(0)::int` / `(1)::int` behave identically to
 * `(false)::int` / `(true)::int`).
 *
 * `is_exempt` (Finding 9, P14 review-fix F2) is bound as a genuine JS
 * boolean, NOT `0`/`1` - unlike `is_new_conversation`/`is_group` above, the
 * landed SQL text uses `$is_exempt` BARE in a boolean context (`NOT
 * $is_exempt`, `CASE WHEN $is_exempt THEN ...`), which forces `bool`
 * inference exactly the same way `reserve-pacing.sql`'s own
 * `$is_new_conversation` does - the `0`/`1` workaround above does not apply
 * to this parameter.
 */
export async function releasePacing(
  sql: PacingQueryable,
  input: ReleasePacingInput,
): Promise<ReleasePacingRow | undefined> {
  const query = await loadQuery('release-pacing');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    ledger_date: input.ledgerDate,
    message_job_id: input.messageJobId,
    is_new_conversation: input.isNewConversation ? 1 : 0,
    is_group: input.isGroup ? 1 : 0,
    is_exempt: input.isExempt,
    gap_ms: input.gapMs,
  });
  const result = await sql.query<ReleasePacingSqlRow>(query.text, params);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    consumedCount: row.consumed_count,
    sentThisHour: row.sent_this_hour,
    newConvCount: row.new_conv_count,
    groupSentCount: row.group_sent_count,
    nextEligibleAt: row.next_eligible_at,
    refundCount: row.refund_count,
  };
}

export interface EnsureLedgerRowInput {
  clientId: string;
  instanceId: string;
}

/**
 * Runs `db/queries/pacing-ensure-ledger-row.sql` - creates today's
 * `pacing_ledger` row (zero-valued) if it does not already exist. Callers
 * (`engine/pacing/index.ts#reserve`) MUST run this, and its sibling
 * `ensureDailyUsageRow`, in the SAME transaction IMMEDIATELY BEFORE
 * `reservePacing` - see that SQL file's own header for the MVCC-snapshot
 * rationale (Finding 5). A missing `instance_pacing_state` row makes this a
 * safe no-op (Finding 3 composition, see the SQL file's own header) -
 * never a thrown error.
 */
export async function ensurePacingLedgerRow(
  sql: PacingQueryable,
  input: EnsureLedgerRowInput,
): Promise<void> {
  const query = await loadQuery('pacing-ensure-ledger-row');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: input.clientId,
  });
  await sql.query(query.text, params);
}

/**
 * Runs `db/queries/pacing-ensure-daily-usage-row.sql` - creates today's
 * `client_daily_usage` row (zero-valued) if it does not already exist. See
 * `ensurePacingLedgerRow`'s own doc comment for the required call
 * ordering/transaction discipline; identical here.
 */
export async function ensureDailyUsageRow(
  sql: PacingQueryable,
  input: EnsureLedgerRowInput,
): Promise<void> {
  const query = await loadQuery('pacing-ensure-daily-usage-row');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: input.clientId,
  });
  await sql.query(query.text, params);
}
