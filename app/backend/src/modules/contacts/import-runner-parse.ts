import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import { normaliseE164, waJidFromE164 } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { attrsByteLength, renderRecord, type ImportMapping } from './import-upload.js';

/**
 * import-runner-parse.ts (P20 Unit U5, step 6) - the CSV-record-reading and
 * per-record classification half of the resumable import sweep, split out
 * of `import-runner.ts` purely for that file's own max-lines cap.
 *
 * `readImportBatch` reads RECORDS (never lines) via csv-parse's `from`
 * option (verified: `from` counts records post-header, immune to embedded
 * quoted newlines - `from_line` counts raw lines and desynchronises on
 * exactly that input, see this unit's own dispatch notes). It reads at most
 * `batchSize + 1` records (ONE extra "probe" record, never classified/
 * processed, purely to detect true EOF without an extra empty sweep when
 * the file's record count is an exact multiple of `batchSize`), so the
 * in-memory footprint per batch never exceeds `batchSize + 1` records.
 *
 * KNOWN LIMITATION (documented, not silently swallowed): `csv-parse`'s
 * `from`/`to` are NOT a byte seek - reaching record N always requires
 * re-scanning every byte from the start of the stream (verified
 * empirically: `parser.info.bytes` after resuming at record N equals the
 * FULL bytes consumed since record 1, not since the previous batch's
 * cursor). `ObjectStore.getStream(key)` (P20 Unit U3) has no byte-range/
 * offset parameter, so there is no in-scope way to seek past
 * already-processed bytes without re-reading them. Consequently a LATE
 * batch's "bytes pulled from the object store" approaches the whole file's
 * size, even though the in-memory footprint stays bounded at
 * `batchSize + 1` records throughout - "never materialised" holds for
 * MEMORY, not for cumulative I/O across the full resumable import. Adding a
 * real byte-offset resume path would require extending the `ObjectStore`
 * interface (out of this unit's file scope, owned by U3) - see this unit's
 * own dispatch report for the finding.
 */

const MAX_ATTRS_BYTES = 2048;
/** Cap on retained `contact_import_errors` rows per import - the rest are counted via `invalid_count` only. */
export const MAX_RETAINED_ERRORS_PER_IMPORT = 1000;
/** Cap on a retained error row's `raw_excerpt`. */
const MAX_RAW_EXCERPT_CHARS = 120;

/**
 * `attrs_too_large` is `readImportBatch`'s own pre-upsert size classification
 * (the rendered `attrs` bag alone exceeds `MAX_ATTRS_BYTES`).
 * `attrs_too_large_after_merge` (M4) is distinct: `upsertRowByRow`
 * (`import-runner-batch.ts`) uses it for a row that passed THAT check but
 * whose `attrs` overflows only AFTER the SQL-side `||` merge with an
 * existing contact's stored `attrs` on an update (the DB's own
 * `contacts_attrs_max_2048` CHECK, migration 0060) - a different cause the
 * caller must be able to tell apart from a same-batch import-time size
 * rejection.
 */
export type InvalidReason =
  | 'empty_phone'
  | 'unparsable_phone'
  | 'not_mobile_plausible'
  | 'attrs_too_large'
  | 'attrs_too_large_after_merge';

export interface ClassifiedValidRecord {
  recordNo: number;
  e164: string;
  waJid: string;
  phoneHash: Buffer;
  displayName: string | null;
  attrs: Record<string, string>;
}

export interface ClassifiedErrorRecord {
  recordNo: number;
  reason: InvalidReason;
  rawExcerpt: string;
}

export interface ClassifiedDuplicateRecord {
  recordNo: number;
  e164: string;
}

export interface ImportBatch {
  /** Records that passed phone normalisation/attrs sizing AND are the first occurrence of their e164 within this batch. */
  valid: ClassifiedValidRecord[];
  /** Records rejected by phone normalisation or attrs sizing. */
  invalid: ClassifiedErrorRecord[];
  /** Records that repeated an e164 already seen earlier IN THIS BATCH - the first occurrence wins and is classified `valid`. */
  duplicates: ClassifiedDuplicateRecord[];
  /** Number of CSV records actually read this batch - fewer than `batchSize` means end-of-file. */
  recordsRead: number;
  /** `recordsRead < batchSize` - the batch reached the end of the file. */
  isEof: boolean;
}

function reasonForE164Failure(
  reason: 'empty' | 'unparsable' | 'not_mobile_plausible',
): InvalidReason {
  if (reason === 'empty') return 'empty_phone';
  if (reason === 'unparsable') return 'unparsable_phone';
  return 'not_mobile_plausible';
}

/**
 * Reads up to `batchSize` CSV records starting at `cursorRow` (0-indexed
 * count of records already processed; csv-parse's `from` is 1-indexed and
 * counts POST-HEADER records, so `from: cursorRow + 1` resumes exactly
 * where the last batch left off), classifies every record, and destroys the
 * stream once the batch is read - the in-memory footprint never exceeds one
 * batch (see module doc for the byte-level I/O caveat).
 */
export async function readImportBatch(
  stream: Readable,
  opts: {
    importId: string;
    mapping: ImportMapping;
    defaultCountry: string;
    cursorRow: number;
    batchSize: number;
    keyProvider: KeyProvider;
    onRecord?: (ctx: { recordNo: number }) => void;
  },
): Promise<ImportBatch> {
  // Reads ONE extra record beyond `batchSize` purely to detect true EOF -
  // when the file's record count is an exact multiple of `batchSize` (e.g.
  // 10,000 rows / 500 per batch), a batch that reads exactly `batchSize`
  // records is otherwise indistinguishable from "there are more" and would
  // need a wasted 21st, zero-record sweep to notice EOF. The probe record
  // (if present) is never classified/processed - only used to set `isEof`.
  const probeRecords = await readRawRecords(stream, opts.cursorRow, opts.batchSize + 1);
  const isEof = probeRecords.length <= opts.batchSize;
  const records = isEof ? probeRecords : probeRecords.slice(0, opts.batchSize);

  const valid: ClassifiedValidRecord[] = [];
  const invalid: ClassifiedErrorRecord[] = [];
  const duplicates: ClassifiedDuplicateRecord[] = [];
  const seenE164 = new Set<string>();

  for (const entry of records) {
    opts.onRecord?.({ recordNo: entry.recordNo });
    const rendered = renderRecord(entry.raw, opts.mapping);

    const normalised = normaliseE164(rendered.rawPhone, opts.defaultCountry);
    if (!normalised.ok) {
      invalid.push({
        recordNo: entry.recordNo,
        reason: reasonForE164Failure(normalised.reason),
        rawExcerpt: rendered.rawPhone.slice(0, MAX_RAW_EXCERPT_CHARS),
      });
      continue;
    }

    if (attrsByteLength(rendered.attrs) > MAX_ATTRS_BYTES) {
      invalid.push({
        recordNo: entry.recordNo,
        reason: 'attrs_too_large',
        rawExcerpt: rendered.rawPhone.slice(0, MAX_RAW_EXCERPT_CHARS),
      });
      continue;
    }

    if (seenE164.has(normalised.e164)) {
      duplicates.push({ recordNo: entry.recordNo, e164: normalised.e164 });
      continue;
    }
    seenE164.add(normalised.e164);

    valid.push({
      recordNo: entry.recordNo,
      e164: normalised.e164,
      waJid: waJidFromE164(normalised.e164),
      phoneHash: hashRecipient(opts.keyProvider, normalised.e164),
      displayName: rendered.displayName,
      attrs: rendered.attrs,
    });
  }

  return {
    valid,
    invalid,
    duplicates,
    recordsRead: records.length,
    isEof,
  };
}

interface RawRecordEntry {
  recordNo: number;
  raw: Record<string, string>;
}

/** Reads exactly the next `maxRecords` records (or fewer at EOF) after `cursorRow`, then destroys `stream`. */
async function readRawRecords(
  stream: Readable,
  cursorRow: number,
  maxRecords: number,
): Promise<RawRecordEntry[]> {
  return new Promise((resolve, reject) => {
    const parser = parse({
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      from: cursorRow + 1,
      to: cursorRow + maxRecords,
    });

    const out: RawRecordEntry[] = [];
    let settled = false;

    function finish(err?: unknown): void {
      if (settled) return;
      settled = true;
      parser.destroy();
      stream.destroy();
      if (err) {
        reject(err as Error);
      } else {
        resolve(out);
      }
    }

    parser.on('data', (record: Record<string, string>) => {
      const recordNo = cursorRow + out.length + 1;
      out.push({ recordNo, raw: record });
      if (out.length >= maxRecords) {
        finish();
      }
    });
    parser.on('end', () => {
      finish();
    });
    parser.on('error', (err) => {
      finish(err);
    });

    stream.pipe(parser);
  });
}
