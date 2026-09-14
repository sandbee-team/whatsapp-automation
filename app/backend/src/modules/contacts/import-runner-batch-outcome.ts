import type { TenantQueryable } from '@wp/db';
import type { ContactsMetricsHandles } from '../../platform/metrics/contacts.js';
import type { ClassifiedErrorRecord } from './import-runner-parse.js';
import type { UpsertOutcome } from './import-runner-batch.js';

/**
 * import-runner-batch-outcome.ts (P20 C1 M1 line-cap split) - the per-batch
 * outcome-metrics recording and the `cursor_row`/count-advancing UPDATE,
 * split out of `import-runner.ts` purely for that file's own max-lines cap
 * (same split idiom as `session-worker-discovery-wiring.ts`). Runs at the
 * end of `processClaimedBatch`, AFTER the upsert/error-row/tag-link writes
 * and the `onBeforeCommit` hook - never before.
 */

export interface RecordBatchOutcomeInput {
  clientId: string;
  importId: string;
  outcomes: UpsertOutcome[];
  invalid: ClassifiedErrorRecord[];
  mergeFailures: ClassifiedErrorRecord[];
  duplicateCount: number;
  recordsRead: number;
  isEof: boolean;
  metrics: ContactsMetricsHandles;
}

/** Increments the per-record outcome counters (`imported`/`updated`/`opted_out_preserved`/`duplicate`/`invalid`) for one batch. */
export function recordBatchRowMetrics(input: RecordBatchOutcomeInput): void {
  for (const outcome of input.outcomes) {
    input.metrics.contactImportRowsTotal.inc({
      result:
        outcome.optOutState === 'opted_out'
          ? 'opted_out_preserved'
          : outcome.inserted
            ? 'imported'
            : 'updated',
    });
  }
  for (let i = 0; i < input.duplicateCount; i += 1) {
    input.metrics.contactImportRowsTotal.inc({ result: 'duplicate' });
  }
  const invalidTotal = input.invalid.length + input.mergeFailures.length;
  for (let i = 0; i < invalidTotal; i += 1) {
    input.metrics.contactImportRowsTotal.inc({ result: 'invalid' });
  }
}

/** Advances `cursor_row` and every running count by this batch's totals - marks the import `done` when `isEof`. Returns the derived per-batch counts for the caller's own use (e.g. metrics already recorded by `recordBatchRowMetrics`). */
export async function advanceImportCursor(
  tx: TenantQueryable,
  input: RecordBatchOutcomeInput,
): Promise<void> {
  const importedCount = input.outcomes.filter((o) => o.inserted).length;
  const updatedCount = input.outcomes.filter((o) => !o.inserted).length;
  const optedOutCount = input.outcomes.filter((o) => o.optOutState === 'opted_out').length;
  const invalidCount = input.invalid.length + input.mergeFailures.length;

  await tx.query(
    `UPDATE contact_imports SET cursor_row = cursor_row + $3,
            imported_count = imported_count + $4,
            updated_count = updated_count + $5,
            invalid_count = invalid_count + $6,
            duplicate_count = duplicate_count + $7,
            opted_out_count = opted_out_count + $8
            ${input.isEof ? ", status = 'done', finished_at = now(), total_rows = cursor_row + $3" : ''}
      WHERE client_id = $1 AND id = $2 AND status = 'importing'
      -- client_id = $1`,
    [
      input.clientId,
      input.importId,
      input.recordsRead,
      importedCount,
      updatedCount,
      invalidCount,
      input.duplicateCount,
      optedOutCount,
    ],
  );

  if (input.isEof) {
    input.metrics.contactsImportedTotal.inc({ result: 'done' });
  }
}
