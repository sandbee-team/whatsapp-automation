import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { resolveEffectiveMaxContacts, countLiveContacts } from './contacts.repo.js';
import { admissionLockKey } from './contacts-limits.js';
import {
  MAX_RETAINED_ERRORS_PER_IMPORT,
  type ClassifiedErrorRecord,
  type ClassifiedValidRecord,
} from './import-runner-parse.js';

/**
 * A row insertable via `insertErrorRows` - wider than `ClassifiedErrorRecord`
 * (whose `reason` is the closed `InvalidReason` per-record classification
 * union): `processOneClientBatch`'s plan-limit re-check also routes through
 * this same insert path with its own reason (`'max_contacts_exceeded'`,
 * never a per-record classification), and `contact_import_errors.reason` is
 * a plain `text` column with no DB-level enum constraint - callers are free
 * to pass any non-empty reason string.
 */
export interface InsertableErrorRow {
  recordNo: number;
  reason: string;
  rawExcerpt: string | null;
}

/**
 * import-runner-batch.ts (P20 Unit U5, step 6) - the DB-write half of one
 * import batch: the plan-limit re-check, error-row insertion (capped at
 * `MAX_RETAINED_ERRORS_PER_IMPORT`), the `upsert-import-contacts.sql` call
 * (with its SAVEPOINT/per-row fallback on an `attrs` CHECK violation), and
 * the `apply_tag_ids` linking - split out of `import-runner.ts` purely for
 * that file's own max-lines cap.
 */

export interface InsertErrorRowsResult {
  /** How many of `errors` were actually inserted (capped at the 1000-per-import retention limit). */
  insertedCount: number;
}

/**
 * Inserts `errors` as `contact_import_errors` rows, but only while
 * `(already_retained + inserted_so_far) < MAX_RETAINED_ERRORS_PER_IMPORT` -
 * the rest are silently dropped (the caller still counts every one of them
 * toward `invalid_count`, which is NOT capped).
 */
export async function insertErrorRows(
  tx: TenantQueryable,
  input: { clientId: string; importId: string; errors: InsertableErrorRow[] },
): Promise<InsertErrorRowsResult> {
  if (input.errors.length === 0) {
    return { insertedCount: 0 };
  }

  const existingCountResult = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM contact_import_errors
      WHERE client_id = $1 AND import_id = $2
      -- client_id = $1`,
    [input.clientId, input.importId],
  );
  const alreadyRetained = Number(existingCountResult.rows[0]?.count ?? 0);
  const room = Math.max(0, MAX_RETAINED_ERRORS_PER_IMPORT - alreadyRetained);
  const toInsert = input.errors.slice(0, room);

  for (const error of toInsert) {
    await tx.query(
      `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason, raw_excerpt)
       VALUES ($1, $2, $3, $4, $5)
       -- client_id = $2
       ON CONFLICT (import_id, row_no) DO NOTHING`,
      [input.importId, input.clientId, error.recordNo, error.reason, error.rawExcerpt],
    );
  }

  return { insertedCount: toInsert.length };
}

export type MaxContactsCheckResult =
  { ok: true } | { ok: false; reason: 'no_plan' | 'limit_exceeded' };

/**
 * Re-checks the effective `max_contacts` plan limit BEFORE the batch upsert
 * (fail-closed: `null` effective limit = no plan = zero capacity, never
 * "unlimited" - same convention as `contacts.repo.ts#resolveEffectiveMaxContacts`).
 * `restE164s` is the set of e164 values this batch is about to write that are
 * NOT already live for the tenant - only those actually grow the live count.
 * Takes the SAME per-client advisory lock `assertUnderContactLimit` does
 * (`contacts-limits.ts` addendum A) FIRST, so a batch import is serialised
 * against concurrent `createContact` calls too.
 */
export async function checkMaxContactsBeforeUpsert(
  tx: TenantQueryable,
  clientId: string,
  candidateE164s: string[],
): Promise<MaxContactsCheckResult> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [admissionLockKey(clientId)]);

  const limit = await resolveEffectiveMaxContacts(tx, clientId);
  if (limit === null) {
    return { ok: false, reason: 'no_plan' };
  }
  if (candidateE164s.length === 0) {
    return { ok: true };
  }

  const existingResult = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM contacts
      WHERE client_id = $1 AND deleted_at IS NULL AND phone_e164 = ANY($2::text[])
      -- client_id = $1`,
    [clientId, candidateE164s],
  );
  const existing = Number(existingResult.rows[0]?.count ?? 0);
  const netNew = candidateE164s.length - existing;

  const currentLive = await countLiveContacts(tx, clientId);
  if (currentLive + netNew > limit) {
    return { ok: false, reason: 'limit_exceeded' };
  }
  return { ok: true };
}

export interface UpsertOutcome {
  id: string;
  phoneE164: string;
  optOutState: 'none' | 'opted_out';
  inserted: boolean;
}

interface RawUpsertRow extends Record<string, unknown> {
  id: string;
  phone_e164: string;
  opt_out_state: 'none' | 'opted_out';
  inserted: boolean;
}

/**
 * Runs `upsert-import-contacts.sql` for the whole batch inside
 * `SAVEPOINT batch_upsert`. On a `23514` (attrs CHECK, e.g. the merged
 * `attrs` exceeding 2048 bytes after `||`) it rolls back to the savepoint
 * and falls back to per-row upserts (each in its own nested savepoint),
 * routing failing rows to `attrs_too_large_after_merge` error records
 * instead of failing the whole batch.
 */
export async function upsertBatch(
  tx: TenantQueryable,
  input: {
    clientId: string;
    importId: string;
    createdByUserId: string;
    records: ClassifiedValidRecord[];
  },
): Promise<{ outcomes: UpsertOutcome[]; mergeFailures: ClassifiedErrorRecord[] }> {
  if (input.records.length === 0) {
    return { outcomes: [], mergeFailures: [] };
  }

  const query = await loadQuery('upsert-import-contacts');

  await tx.query('SAVEPOINT batch_upsert');
  try {
    const params = bindQueryParams(query, {
      client_id: input.clientId,
      import_id: input.importId,
      created_by_user_id: input.createdByUserId,
      phone_e164s: input.records.map((r) => r.e164),
      phone_hashes: input.records.map((r) => r.phoneHash),
      wa_jids: input.records.map((r) => r.waJid),
      display_names: input.records.map((r) => r.displayName),
      attrs_list: input.records.map((r) => JSON.stringify(r.attrs)),
    });
    const result = await tx.query<RawUpsertRow>(query.text, params);
    await tx.query('RELEASE SAVEPOINT batch_upsert');
    return { outcomes: result.rows.map(mapUpsertRow), mergeFailures: [] };
  } catch (err) {
    if (!isCheckViolation(err)) {
      throw err;
    }
    await tx.query('ROLLBACK TO SAVEPOINT batch_upsert');
    await tx.query('RELEASE SAVEPOINT batch_upsert');
    return upsertRowByRow(tx, query, input);
  }
}

function mapUpsertRow(row: RawUpsertRow): UpsertOutcome {
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    optOutState: row.opt_out_state,
    inserted: row.inserted,
  };
}

function isCheckViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23514';
}

/** Per-row fallback after a batch-level CHECK violation - one savepoint per row so a single bad row never aborts the rest. */
async function upsertRowByRow(
  tx: TenantQueryable,
  query: Awaited<ReturnType<typeof loadQuery>>,
  input: {
    clientId: string;
    importId: string;
    createdByUserId: string;
    records: ClassifiedValidRecord[];
  },
): Promise<{ outcomes: UpsertOutcome[]; mergeFailures: ClassifiedErrorRecord[] }> {
  const outcomes: UpsertOutcome[] = [];
  const mergeFailures: ClassifiedErrorRecord[] = [];

  for (const record of input.records) {
    await tx.query('SAVEPOINT batch_upsert_row');
    try {
      const params = bindQueryParams(query, {
        client_id: input.clientId,
        import_id: input.importId,
        created_by_user_id: input.createdByUserId,
        phone_e164s: [record.e164],
        phone_hashes: [record.phoneHash],
        wa_jids: [record.waJid],
        display_names: [record.displayName],
        attrs_list: [JSON.stringify(record.attrs)],
      });
      const result = await tx.query<RawUpsertRow>(query.text, params);
      await tx.query('RELEASE SAVEPOINT batch_upsert_row');
      const row = result.rows[0];
      if (row) outcomes.push(mapUpsertRow(row));
    } catch (err) {
      if (!isCheckViolation(err)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT batch_upsert_row');
      await tx.query('RELEASE SAVEPOINT batch_upsert_row');
      mergeFailures.push({
        recordNo: record.recordNo,
        reason: 'attrs_too_large_after_merge' as const,
        rawExcerpt: record.e164.slice(0, 120),
      });
    }
  }

  return { outcomes, mergeFailures };
}

/**
 * Links `contactIds` to `tagIds` (`ON CONFLICT DO NOTHING`) and bumps each
 * linked tag's `contact_count` by the number of NEW links it actually got.
 * `contact_tags` is JOINED into the INSERT's candidate set (addendum B) so
 * a `tagIds` entry belonging to a DIFFERENT tenant is silently excluded,
 * never written as a cross-tenant link - `contact_tag_links.tag_id` is a
 * plain `REFERENCES contact_tags(id)` (migration 0060, no composite FK on
 * `(client_id, tag_id)` yet), and RLS on `contact_tag_links` only checks
 * its OWN `client_id`, so without this join the INSERT would otherwise
 * happily write a `(client_id=A, tag_id=B's id)` row.
 */
export async function applyTags(
  tx: TenantQueryable,
  input: { clientId: string; tagIds: string[]; contactIds: string[] },
): Promise<void> {
  if (input.tagIds.length === 0 || input.contactIds.length === 0) {
    return;
  }

  const linkResult = await tx.query<{ tag_id: string }>(
    `INSERT INTO contact_tag_links (client_id, tag_id, contact_id)
     SELECT $1, t.id, c.id
       FROM contact_tags t
       JOIN unnest($2::uuid[]) AS ids(id) ON ids.id = t.id AND t.client_id = $1
       CROSS JOIN unnest($3::uuid[]) AS c(id)
     -- client_id = $1
     ON CONFLICT DO NOTHING
     RETURNING tag_id`,
    [input.clientId, input.tagIds, input.contactIds],
  );

  const countByTag = new Map<string, number>();
  for (const row of linkResult.rows) {
    countByTag.set(row.tag_id, (countByTag.get(row.tag_id) ?? 0) + 1);
  }

  for (const [tagId, count] of countByTag) {
    await tx.query(
      `UPDATE contact_tags SET contact_count = contact_count + $1
        WHERE client_id = $2 AND id = $3
        -- client_id = $2`,
      [count, input.clientId, tagId],
    );
  }
}
