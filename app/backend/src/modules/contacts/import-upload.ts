import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';

/**
 * import-upload.ts (P20 Unit U5, step 5) - the pure, DB-free half of the CSV
 * import upload flow: header/preview sniffing and mapping validation. Never
 * reads a whole file into memory - `sniffCsvHeader` reads only the header
 * plus `PREVIEW_ROWS` records, then destroys the source stream, so a
 * caller can preview a 16 MB upload without buffering it.
 *
 * `renderRecord`/`attrsByteLength` are the pure per-record shaping helpers
 * `import-runner.ts` reuses for every batch - kept here (not duplicated) so
 * the "one function owns the conversion" rule (core invariants doc, "Units
 * and quantities") applies to CSV-record shaping the same way it does to
 * numeric derivations.
 */

/** Hard byte cap on an uploaded CSV - matches `object-store.ts`'s `maxBytes` contract for `kind: 'imports'`. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const UPLOAD_CONTENT_TYPE = 'text/csv' as const;
/** How many CSV records `sniffCsvHeader` reads for its preview, beyond the header itself. */
export const PREVIEW_ROWS = 10;

export interface CsvHeaderSniff {
  columns: string[];
  preview: string[][];
  delimiter: ',' | ';' | '\t';
}

const CANDIDATE_DELIMITERS = [',', ';', '\t'] as const;

/** Picks the delimiter whose header line splits into the most columns (a wrong guess collapses to one column). Reads only the FIRST line - never the whole file. */
function pickDelimiter(firstLine: string): ',' | ';' | '\t' {
  let best: ',' | ';' | '\t' = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = firstLine.split(candidate).length;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Reads only the header row plus up to `PREVIEW_ROWS` records from `stream`,
 * then destroys it - a 16 MB upload is never fully read just to build a
 * mapping preview. The delimiter is sniffed from a small leading chunk of
 * the stream (`pickDelimiter`) before the real parse begins.
 */
export async function sniffCsvHeader(stream: Readable): Promise<CsvHeaderSniff> {
  const { firstChunk, rest } = await peekFirstLine(stream);
  const delimiter = pickDelimiter(firstChunk);

  return new Promise((resolve, reject) => {
    const parser = parse({
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      to: PREVIEW_ROWS + 1,
    });

    let columns: string[] = [];
    const preview: string[][] = [];
    let settled = false;

    function finish(result?: CsvHeaderSniff, err?: unknown): void {
      if (settled) return;
      settled = true;
      parser.destroy();
      rest.destroy();
      if (err) {
        reject(err as Error);
      } else {
        resolve(result ?? { columns, preview, delimiter });
      }
    }

    parser.on('data', (record: string[]) => {
      if (columns.length === 0) {
        columns = record;
      } else {
        preview.push(record);
      }
      if (preview.length >= PREVIEW_ROWS) {
        finish({ columns, preview, delimiter });
      }
    });
    parser.on('end', () => {
      finish();
    });
    parser.on('error', (err) => {
      finish(undefined, err);
    });

    rest.pipe(parser);
  });
}

/**
 * Buffers only up to the first newline (bounded: stops at 64 KiB even
 * without one, so a pathological headerless upload can't buffer forever),
 * returning that leading text (for delimiter sniffing) plus the ORIGINAL
 * stream still positioned at its start (via `stream.unshift`) so the real
 * parse below sees every byte, including the peeked ones.
 */
async function peekFirstLine(stream: Readable): Promise<{ firstChunk: string; rest: Readable }> {
  const MAX_PEEK_BYTES = 65536;
  let buffered = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    function onData(chunk: Buffer | string): void {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      buffered = Buffer.concat([buffered, chunkBuffer]);
      const newlineIndex = buffered.indexOf(0x0a);
      if (newlineIndex !== -1 || buffered.length >= MAX_PEEK_BYTES) {
        stream.pause();
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        stream.removeListener('end', onEnd);
        stream.unshift(buffered);
        resolve({ firstChunk: buffered.toString('utf8'), rest: stream });
      }
    }
    function onError(err: unknown): void {
      reject(err as Error);
    }
    function onEnd(): void {
      stream.unshift(buffered);
      resolve({ firstChunk: buffered.toString('utf8'), rest: stream });
    }
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
  });
}

export interface ImportMapping {
  phone: string;
  name?: string | null;
  attrs?: Record<string, string>;
}

const ATTR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ATTR_ENTRIES = 20;

export type ValidateMappingResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validates `mapping` against the sniffed `columns` list. Every referenced
 * CSV column must actually exist; `attrs` keys must be lower_snake_case
 * (`/^[a-z][a-z0-9_]{0,31}$/`), capped at 20 entries, and never shadow the
 * reserved `phone` key.
 */
export function validateMapping(mapping: ImportMapping, columns: string[]): ValidateMappingResult {
  const errors: string[] = [];
  const columnSet = new Set(columns);

  if (!mapping.phone || !columnSet.has(mapping.phone)) {
    errors.push(`mapping.phone must reference an existing column, got: ${String(mapping.phone)}`);
  }
  if (mapping.name !== undefined && mapping.name !== null && !columnSet.has(mapping.name)) {
    errors.push(`mapping.name must reference an existing column, got: ${mapping.name}`);
  }

  const attrs = mapping.attrs ?? {};
  const attrEntries = Object.entries(attrs);
  if (attrEntries.length > MAX_ATTR_ENTRIES) {
    errors.push(`mapping.attrs may hold at most ${String(MAX_ATTR_ENTRIES)} entries`);
  }
  for (const [key, column] of attrEntries) {
    if (key === 'phone') {
      errors.push('mapping.attrs may not use the reserved key "phone"');
    }
    if (!ATTR_KEY_PATTERN.test(key)) {
      errors.push(`mapping.attrs key "${key}" must match ${String(ATTR_KEY_PATTERN)}`);
    }
    if (!columnSet.has(column)) {
      errors.push(`mapping.attrs["${key}"] must reference an existing column, got: ${column}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface RenderedRecord {
  rawPhone: string;
  displayName: string | null;
  attrs: Record<string, string>;
}

/** Empty string in a mapped column becomes `null` (name) or an omitted key (attrs), never a stored empty string. */
export function renderRecord(
  record: Record<string, string>,
  mapping: ImportMapping,
): RenderedRecord {
  const rawPhone = record[mapping.phone] ?? '';

  const nameColumn = mapping.name;
  const rawName = nameColumn ? record[nameColumn] : undefined;
  const displayName = rawName && rawName.trim() !== '' ? rawName : null;

  const attrs: Record<string, string> = {};
  for (const [key, column] of Object.entries(mapping.attrs ?? {})) {
    const value = record[column];
    if (value !== undefined && value.trim() !== '') {
      attrs[key] = value;
    }
  }

  return { rawPhone, displayName, attrs };
}

/** Byte length of `attrs` as it will be merged/stored - the same measure `contacts_attrs_max_2048` CHECKs against. */
export function attrsByteLength(attrs: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(attrs));
}
