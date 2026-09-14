import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  attrsByteLength,
  MAX_UPLOAD_BYTES,
  PREVIEW_ROWS,
  renderRecord,
  sniffCsvHeader,
  UPLOAD_CONTENT_TYPE,
  validateMapping,
  type ImportMapping,
} from './import-upload.js';

/**
 * import-upload.test.ts (P20 Unit U5, step 5) - pure unit tests for the
 * upload/mapping half of the CSV import flow: no Postgres, no object
 * store, no `@wp/server-kit` import chain (so no stub-env first-import is
 * needed).
 */

describe('constants', () => {
  it('exposes_the_expected_upload_bounds', () => {
    expect(MAX_UPLOAD_BYTES).toBe(16 * 1024 * 1024);
    expect(UPLOAD_CONTENT_TYPE).toBe('text/csv');
    expect(PREVIEW_ROWS).toBe(10);
  });
});

describe('sniffCsvHeader', () => {
  it('reads_only_the_header_and_preview_rows_for_a_comma_delimited_csv', async () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `+91900000${String(i).padStart(4, '0')},Name ${i},City ${i}`,
    );
    const csv = `phone,name,city\n${rows.join('\n')}\n`;
    const stream = Readable.from([csv]);

    const sniff = await sniffCsvHeader(stream);

    expect(sniff.columns).toEqual(['phone', 'name', 'city']);
    expect(sniff.delimiter).toBe(',');
    expect(sniff.preview).toHaveLength(PREVIEW_ROWS);
    expect(sniff.preview[0]).toEqual(['+919000000000', 'Name 0', 'City 0']);
  });

  it('handles_a_bom_prefixed_utf8_file', async () => {
    const csv = '﻿phone,name\n+919000000001,Alice\n';
    const stream = Readable.from([csv]);

    const sniff = await sniffCsvHeader(stream);

    expect(sniff.columns).toEqual(['phone', 'name']);
    expect(sniff.preview).toEqual([['+919000000001', 'Alice']]);
  });

  it('sniffs_a_semicolon_delimiter', async () => {
    const csv = 'phone;name\n+919000000001;Alice\n+919000000002;Bob\n';
    const stream = Readable.from([csv]);

    const sniff = await sniffCsvHeader(stream);

    expect(sniff.delimiter).toBe(';');
    expect(sniff.columns).toEqual(['phone', 'name']);
  });

  it('sniffs_a_tab_delimiter', async () => {
    const csv = 'phone\tname\n+919000000001\tAlice\n';
    const stream = Readable.from([csv]);

    const sniff = await sniffCsvHeader(stream);

    expect(sniff.delimiter).toBe('\t');
    expect(sniff.columns).toEqual(['phone', 'name']);
  });

  it('never_reads_the_full_stream_for_a_file_larger_than_the_preview_window', async () => {
    const totalRows = 5000;
    let pulled = 0;
    async function* generate(): AsyncGenerator<string> {
      yield 'phone,name\n';
      for (let i = 0; i < totalRows; i += 1) {
        pulled += 1;
        yield `+9190000${String(i).padStart(5, '0')},Name ${i}\n`;
      }
    }
    const stream = Readable.from(generate());

    await sniffCsvHeader(stream);

    // Bounded: far fewer than the full 5000-row body was ever pulled.
    expect(pulled).toBeLessThan(totalRows / 2);
  });
});

describe('validateMapping', () => {
  const columns = ['phone', 'name', 'city', 'plan'];

  it('accepts_a_mapping_whose_columns_all_exist', () => {
    const mapping: ImportMapping = { phone: 'phone', name: 'name', attrs: { city: 'city' } };
    expect(validateMapping(mapping, columns)).toEqual({ ok: true });
  });

  it('rejects_a_phone_column_that_does_not_exist', () => {
    const mapping: ImportMapping = { phone: 'missing' };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('mapping.phone'))).toBe(true);
    }
  });

  it('rejects_a_name_column_that_does_not_exist', () => {
    const mapping: ImportMapping = { phone: 'phone', name: 'missing' };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
  });

  it('rejects_more_than_twenty_attrs_entries', () => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) {
      attrs[`k${i}`] = 'phone';
    }
    const mapping: ImportMapping = { phone: 'phone', attrs };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('at most 20'))).toBe(true);
    }
  });

  it('rejects_an_attrs_key_that_is_not_lower_snake_case', () => {
    const mapping: ImportMapping = { phone: 'phone', attrs: { CityName: 'city' } };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
  });

  it('rejects_an_attrs_key_named_phone', () => {
    const mapping: ImportMapping = { phone: 'phone', attrs: { phone: 'city' } };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('reserved key "phone"'))).toBe(true);
    }
  });

  it('rejects_an_attrs_value_column_that_does_not_exist', () => {
    const mapping: ImportMapping = { phone: 'phone', attrs: { city: 'missing' } };
    const result = validateMapping(mapping, columns);
    expect(result.ok).toBe(false);
  });
});

describe('renderRecord', () => {
  const mapping: ImportMapping = { phone: 'phone', name: 'name', attrs: { city: 'city' } };

  it('renders_a_full_record', () => {
    const rendered = renderRecord({ phone: '+919000000001', name: 'Alice', city: 'Pune' }, mapping);
    expect(rendered).toEqual({
      rawPhone: '+919000000001',
      displayName: 'Alice',
      attrs: { city: 'Pune' },
    });
  });

  it('maps_an_empty_name_to_null', () => {
    const rendered = renderRecord({ phone: '+919000000001', name: '  ', city: 'Pune' }, mapping);
    expect(rendered.displayName).toBeNull();
  });

  it('omits_an_empty_attrs_value', () => {
    const rendered = renderRecord({ phone: '+919000000001', name: 'Alice', city: '' }, mapping);
    expect(rendered.attrs).toEqual({});
  });

  it('renders_a_missing_phone_column_as_an_empty_string', () => {
    const rendered = renderRecord({ name: 'Alice', city: 'Pune' }, { phone: 'phone' });
    expect(rendered.rawPhone).toBe('');
  });
});

describe('attrsByteLength', () => {
  it('measures_the_json_stringified_byte_length', () => {
    expect(attrsByteLength({ city: 'Pune' })).toBe(Buffer.byteLength('{"city":"Pune"}'));
  });

  it('is_zero_bytes_worth_of_content_for_an_empty_object', () => {
    expect(attrsByteLength({})).toBe(Buffer.byteLength('{}'));
  });
});
