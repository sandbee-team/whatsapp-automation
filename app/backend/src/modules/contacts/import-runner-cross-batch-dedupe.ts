import type { TenantQueryable } from '@wp/db';

/**
 * import-runner-cross-batch-dedupe.ts (P20 C1 M4 gap fix, provenance
 * corrected P20 C1 round-3) - split out of `import-runner-batch.ts` purely
 * for that file's own max-lines cap (same split idiom as
 * `session-worker-discovery-wiring.ts`).
 *
 * Closes the gap `readImportBatch`'s own per-batch `seenE164` set
 * (`import-runner-parse.ts`) cannot: that set only catches a repeat within
 * ONE batch of up to `batchSize` records. A phone that first appeared in an
 * EARLIER batch of the SAME import was previously upserted again on its
 * later occurrence, silently overwriting the first occurrence's
 * `display_name` (the upsert's `DO UPDATE SET display_name = COALESCE(...)`
 * prefers the LATER value) and miscounting it as `updated_count` instead of
 * `duplicate_count`.
 */

/**
 * Finds which of `candidateE164s` this SAME import has already written in
 * an EARLIER batch, so the caller can classify a later repeat as
 * `duplicate` (counted, excluded from the upsert, first occurrence's row
 * left untouched) instead of a genuine DB-level update.
 *
 * A match is `import_id = importId` (this import INSERTED it earlier, the
 * row's ORIGIN) OR `last_import_id = importId` (this import UPDATED a
 * pre-existing contact earlier - `last_import_id`, migration 0062, is
 * stamped by the upsert's `DO UPDATE SET` on every write, so it is exact
 * provenance, not a time-window heuristic). A contact touched by a
 * DIFFERENT actor (a panel PATCH, an inbound event, the nightly mirror
 * reconciler) during this import's run window stamps neither column with
 * THIS import's id, so it correctly matches on its first occurrence here
 * and is `updated_count`, never silently dropped as a false `duplicate`.
 */
export async function findAlreadyWrittenByThisImport(
  tx: TenantQueryable,
  input: { clientId: string; importId: string; candidateE164s: string[] },
): Promise<Set<string>> {
  if (input.candidateE164s.length === 0) {
    return new Set();
  }

  const result = await tx.query<{ phone_e164: string }>(
    `SELECT phone_e164 FROM contacts
      WHERE client_id = $1 AND deleted_at IS NULL AND phone_e164 = ANY($2::text[])
        AND (import_id = $3 OR last_import_id = $3)
      -- client_id = $1`,
    [input.clientId, input.candidateE164s, input.importId],
  );
  return new Set(result.rows.map((r) => r.phone_e164));
}
