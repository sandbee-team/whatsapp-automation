import type { TenantDb, TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { logger } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { assertTenantKey, type ObjectStore } from '../../platform/storage/object-store.js';
import type { ContactsMetricsHandles } from '../../platform/metrics/contacts.js';
import { readImportBatch } from './import-runner-parse.js';
import type { ImportMapping } from './import-upload.js';
import {
  applyTags,
  checkMaxContactsBeforeUpsert,
  insertErrorRows,
  upsertBatch,
} from './import-runner-batch.js';
import { findAlreadyWrittenByThisImport } from './import-runner-cross-batch-dedupe.js';
import {
  classifyImportFailure,
  insertTerminalErrorRow,
  markImportFailedInFreshTx,
} from './import-runner-terminal.js';
import {
  callHookOrThrowInjectedCrash,
  ClaimedBatchError,
  InjectedTestCrashError,
} from './import-runner-failure-wrapping.js';
import { advanceImportCursor, recordBatchRowMetrics } from './import-runner-batch-outcome.js';

/**
 * import-runner.ts (P20 Unit U5, step 6) - the resumable CSV import sweep's
 * orchestration: cross-tenant discovery, one claim + one batch + one upsert
 * per client per tick, all in ONE `tenantDb.withTenant` transaction. A crash
 * anywhere rolls the whole batch back and the next sweep re-reads from the
 * SAME `cursor_row` - the upsert's `ON CONFLICT` makes a re-run a no-op
 * (idempotent, core invariant 3). `hooks` exist ONLY for crash-injection
 * tests - production callers never pass them.
 *
 * CROSS-TENANT AVAILABILITY (P20 C1 M1): the sweep's `for` loop wraps EACH
 * client's batch transaction in its own try/catch so one client's poison
 * import never skips every later client; a throw classifies + marks the
 * import `failed` in a FRESH tx, then the loop continues. Only the
 * pending-clients discovery query may abort the whole sweep.
 */

interface RawPendingClientRow extends Record<string, unknown> {
  client_id: string;
}

interface RawImportClaimRow extends Record<string, unknown> {
  id: string;
  status: 'uploaded' | 'importing';
  storage_key: string;
  mapping: ImportMapping;
  default_country: string;
  apply_tag_ids: string[];
  cursor_row: string | number;
  attested_by_user_id: string;
}

export interface RunOneContactImportSweepDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  keyProvider: KeyProvider;
  objectStore: ObjectStore;
  metrics: ContactsMetricsHandles;
  now?: () => Date;
  batchSize?: number;
  maxClientsPerSweep?: number;
  hooks?: {
    onBeforeCommit?: (ctx: {
      importId: string;
      batchIndex: number;
      recordsInBatch: number;
    }) => void | Promise<void>;
    onRecord?: (ctx: { importId: string; recordNo: number }) => void;
  };
}

export interface RunOneContactImportSweepResult {
  importsTouched: number;
  recordsProcessed: number;
  importsFailed: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_CLIENTS_PER_SWEEP = 20;

/** One sweep: discovers pending clients cross-tenant, then processes exactly ONE batch for each, oldest-import-first, in its own tenant transaction. One client's failure never aborts another's (see module doc). */
export async function runOneContactImportSweep(
  deps: RunOneContactImportSweepDeps,
): Promise<RunOneContactImportSweepResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxClientsPerSweep = deps.maxClientsPerSweep ?? DEFAULT_MAX_CLIENTS_PER_SWEEP;

  const pendingQuery = await loadQuery('contact-imports-pending-clients');
  const pending = await deps.pool.query<RawPendingClientRow>(
    pendingQuery.text,
    bindQueryParams(pendingQuery, { limit: maxClientsPerSweep }),
  );

  let importsTouched = 0;
  let recordsProcessed = 0;
  let importsFailed = 0;

  for (const { client_id: clientId } of pending.rows) {
    try {
      const outcome = await deps.tenantDb.withTenant(clientId, (tx) =>
        processOneClientBatch(tx, clientId, deps, batchSize),
      );
      if (outcome) {
        importsTouched += 1;
        recordsProcessed += outcome.recordsRead;
      }
    } catch (err) {
      if (err instanceof ClaimedBatchError && err.cause instanceof InjectedTestCrashError) {
        // A TEST-ONLY hook threw, simulating "the process really died" -
        // never classify/mark-failed; propagate exactly as pre-M1 so
        // `sweepUntilDone`'s own test-only catch stands in for the process
        // restart (module doc, InjectedTestCrashError's own header).
        throw err.cause.original;
      }
      if (!(err instanceof ClaimedBatchError)) {
        // Never claimed - nothing to mark failed; log name/code only
        // (never `.message`) and move on (NEW-3).
        const name = err instanceof Error ? err.name : 'Error';
        const code = (err as { code?: unknown } | null)?.code;
        const errTag = code ? `${name}/${String(code)}` : name;
        logger.error({ client_id: clientId }, `contact import batch failed: ${errTag}`);
        continue;
      }
      const reason = classifyImportFailure(err.cause);
      await markImportFailedInFreshTx(deps.tenantDb, clientId, err.importId, reason);
      deps.metrics.contactsImportedTotal.inc({ result: 'failed' });
      importsFailed += 1;
    }
  }

  return { importsTouched, recordsProcessed, importsFailed };
}

async function claimNextImport(
  tx: TenantQueryable,
  clientId: string,
): Promise<RawImportClaimRow | undefined> {
  const claimed = await tx.query<RawImportClaimRow>(
    `SELECT id, status, storage_key, mapping, default_country, apply_tag_ids, cursor_row,
            attested_by_user_id
       FROM contact_imports
      WHERE client_id = $1 AND status IN ('uploaded', 'importing')
      -- client_id = $1
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [clientId],
  );
  const row = claimed.rows[0];
  if (!row) return undefined;

  if (row.status === 'uploaded') {
    await tx.query(
      `UPDATE contact_imports SET status = 'importing' WHERE client_id = $1 AND id = $2 -- client_id = $1`,
      [clientId, row.id],
    );
  }
  return row;
}

/** Processes exactly one batch for one client's next claimable import; `undefined` when there is nothing to do. Any failure AFTER a successful claim is rethrown wrapped in `ClaimedBatchError` so the caller can mark that specific import failed (M1). */
async function processOneClientBatch(
  tx: TenantQueryable,
  clientId: string,
  deps: RunOneContactImportSweepDeps,
  batchSize: number,
): Promise<{ recordsRead: number } | undefined> {
  const claim = await claimNextImport(tx, clientId);
  if (!claim) return undefined;

  try {
    return await processClaimedBatch(tx, clientId, claim, deps, batchSize);
  } catch (err) {
    throw new ClaimedBatchError(claim.id, err);
  }
}

/** The post-claim half of `processOneClientBatch` - split so every throw inside it is uniformly wrapped by the caller. */
async function processClaimedBatch(
  tx: TenantQueryable,
  clientId: string,
  claim: RawImportClaimRow,
  deps: RunOneContactImportSweepDeps,
  batchSize: number,
): Promise<{ recordsRead: number }> {
  assertTenantKey(claim.storage_key, clientId);
  const stream = await deps.objectStore.getStream(claim.storage_key);
  const cursorRow = Number(claim.cursor_row);

  const batch = await readImportBatch(stream, {
    importId: claim.id,
    mapping: claim.mapping,
    defaultCountry: claim.default_country,
    cursorRow,
    batchSize,
    keyProvider: deps.keyProvider,
    onRecord: deps.hooks?.onRecord
      ? (ctx) => {
          try {
            deps.hooks?.onRecord?.({ importId: claim.id, recordNo: ctx.recordNo });
          } catch (err) {
            throw new InjectedTestCrashError(err);
          }
        }
      : undefined,
  });

  // Cross-batch within-file dedup (see `findAlreadyWrittenByThisImport`'s
  // own header) - before the plan-limit check and upsert touch a repeat.
  const crossBatchDuplicateE164s = await findAlreadyWrittenByThisImport(tx, {
    clientId,
    importId: claim.id,
    candidateE164s: batch.valid.map((r) => r.e164),
  });
  const freshValid = batch.valid.filter((r) => !crossBatchDuplicateE164s.has(r.e164));
  const crossBatchDuplicateCount = batch.valid.length - freshValid.length;

  const limitCheck = await checkMaxContactsBeforeUpsert(
    tx,
    clientId,
    freshValid.map((r) => r.e164),
  );
  if (!limitCheck.ok) {
    await tx.query(
      `UPDATE contact_imports SET status = 'failed', finished_at = now() WHERE client_id = $1 AND id = $2 -- client_id = $1`,
      [clientId, claim.id],
    );
    // Row-0 sentinel (M3): a genuine per-record parse error may already
    // occupy `row_no = cursor_row + 1` from a prior attempt at this same
    // batch - writing the terminal reason there risks a `DO NOTHING`
    // collision that silently drops it. `row_no = 0` is reserved for
    // import-level terminal reasons ONLY and always overwrites.
    await insertTerminalErrorRow(tx, {
      clientId,
      importId: claim.id,
      reason: 'max_contacts_exceeded',
    });
    deps.metrics.contactsImportedTotal.inc({ result: 'failed' });
    return { recordsRead: batch.recordsRead };
  }

  const { outcomes, mergeFailures } = await upsertBatch(tx, {
    clientId,
    importId: claim.id,
    createdByUserId: claim.attested_by_user_id,
    records: freshValid,
  });

  await insertErrorRows(tx, {
    clientId,
    importId: claim.id,
    errors: [...batch.invalid, ...mergeFailures],
  });

  const outcomeInput = {
    clientId,
    importId: claim.id,
    outcomes,
    invalid: batch.invalid,
    mergeFailures,
    duplicateCount: batch.duplicates.length + crossBatchDuplicateCount,
    recordsRead: batch.recordsRead,
    isEof: batch.isEof,
    metrics: deps.metrics,
  };
  recordBatchRowMetrics(outcomeInput);

  if (claim.apply_tag_ids.length > 0) {
    await applyTags(tx, {
      clientId,
      tagIds: claim.apply_tag_ids,
      contactIds: outcomes.map((o) => o.id),
    });
  }

  if (deps.hooks?.onBeforeCommit) {
    await callHookOrThrowInjectedCrash(() =>
      deps.hooks?.onBeforeCommit?.({
        importId: claim.id,
        batchIndex: Math.floor(cursorRow / batchSize),
        recordsInBatch: batch.recordsRead,
      }),
    );
  }

  await advanceImportCursor(tx, outcomeInput);

  return { recordsRead: batch.recordsRead };
}
