import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  attrsByteLength,
  PREVIEW_ROWS,
  renderRecord,
  sniffCsvHeader,
  validateMapping,
} from './import-upload.js';
import { normaliseE164 } from '@wp/domain';

/**
 * import-upload-empty-huge-c2.test.ts (C2 hardening) - the CSV-pipeline
 * "empty and huge inputs" edge cases from the C2 brief: a header-only file,
 * a header-less/mapping-mismatched file, a 0-byte upload, exact 2048/2049
 * byte attrs boundaries, an unbounded display_name, and the PREVIEW_ROWS
 * boundary. Pure functions only (no DB, no object store) - `@wp/domain` is
 * imported for `normaliseE164` only (no `@wp/server-kit` config singleton in
 * this chain, same precedent as `phone-hash.test.ts`).
 */

function streamOf(text: string): Readable {
  return Readable.from([text]);
}

describe('a CSV with only a header row', () => {
  it('sniffCsvHeader_returns_the_columns_and_an_empty_preview', async () => {
    const sniff = await sniffCsvHeader(streamOf('phone,name\n'));
    expect(sniff.columns).toEqual(['phone', 'name']);
    expect(sniff.preview).toEqual([]);
  });
});

describe('a header-less file (the mapped column is absent)', () => {
  it('validateMapping_rejects_a_phone_column_that_does_not_exist', async () => {
    const sniff = await sniffCsvHeader(streamOf('9876543210\n9123456789\n'));
    // The first "record" IS the header here (there is no real header row),
    // so the sniffed columns are the raw phone-looking strings themselves -
    // 'phone' is never among them.
    const result = validateMapping({ phone: 'phone' }, sniff.columns);
    expect(result).toEqual({
      ok: false,
      errors: ['mapping.phone must reference an existing column, got: phone'],
    });
  });
});

describe('a 0-byte upload', () => {
  it('sniffCsvHeader_returns_empty_columns_for_an_empty_stream', async () => {
    const sniff = await sniffCsvHeader(streamOf(''));
    expect(sniff.columns).toEqual([]);
    expect(sniff.preview).toEqual([]);
  });
});

describe('attrs byte-size boundary', () => {
  it('exactly_2048_bytes_is_under_the_cap_2049_is_over', () => {
    // attrsByteLength measures Buffer.byteLength(JSON.stringify(attrs)) -
    // build a single-key object whose JSON serialisation is EXACTLY 2048
    // bytes, then one byte more.
    const wrapperBytes = Buffer.byteLength(JSON.stringify({ a: '' }));
    const valueLenAt2048 = 2048 - wrapperBytes;
    const exactly2048 = { a: 'x'.repeat(valueLenAt2048) };
    const exactly2049 = { a: 'x'.repeat(valueLenAt2048 + 1) };

    expect(attrsByteLength(exactly2048)).toBe(2048);
    expect(attrsByteLength(exactly2049)).toBe(2049);
    expect(attrsByteLength(exactly2048) <= 2048).toBe(true);
    expect(attrsByteLength(exactly2049) <= 2048).toBe(false);
  });
});

describe('an unbounded display_name', () => {
  it('renderRecord_passes_a_ten_thousand_char_name_through_unchanged', () => {
    const longName = 'N'.repeat(10_000);
    const rendered = renderRecord(
      { phone: '+919876543210', name: longName },
      {
        phone: 'phone',
        name: 'name',
      },
    );
    // import-upload.ts / the contacts schema apply no length cap to
    // display_name (only `attrs` carries a CHECK constraint) - the actual,
    // exact behaviour is "imported unchanged", never truncated here.
    expect(rendered.displayName).toBe(longName);
    expect(rendered.displayName?.length).toBe(10_000);
  });
});

describe('PREVIEW_ROWS boundary', () => {
  it('an_eleven_row_file_previews_exactly_ten', async () => {
    expect(PREVIEW_ROWS).toBe(10);
    const lines = ['phone,name'];
    for (let i = 0; i < 11; i += 1) {
      lines.push(`+9198765${String(40000 + i)},Name ${String(i)}`);
    }
    const sniff = await sniffCsvHeader(streamOf(lines.join('\n') + '\n'));
    expect(sniff.preview.length).toBe(10);
  });
});

describe('empty phone normalises to a typed reason, never a guess', () => {
  it('an_empty_phone_column_value_is_the_empty_reason', () => {
    const rendered = renderRecord({ phone: '' }, { phone: 'phone' });
    expect(rendered.rawPhone).toBe('');
    const normalised = normaliseE164(rendered.rawPhone, 'IN');
    expect(normalised).toEqual({ ok: false, reason: 'empty' });
  });
});
