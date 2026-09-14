import { describe, expect, it } from 'vitest';
import { normaliseE164, waJidFromE164, type E164Reason } from './phone.js';

/**
 * phone.test.ts (P20 Unit U2, step 3) - `normaliseE164`/`waJidFromE164` unit
 * tests. Pure `@wp/domain` module, no `@wp/server-kit` in the import chain,
 * so no `stub-wp-server-kit-env.js` guard is needed here.
 */

describe('normaliseE164', () => {
  it('import_normalises_to_e164_or_rejects_the_row', () => {
    expect(normaliseE164('98765 43210', 'IN')).toEqual({ ok: true, e164: '+919876543210' });
    expect(normaliseE164('+91 98765-43210', 'IN')).toEqual({ ok: true, e164: '+919876543210' });
    expect(normaliseE164('09876543210', 'IN')).toEqual({ ok: true, e164: '+919876543210' });
    expect(normaliseE164('0091 98765 43210', 'IN')).toEqual({ ok: true, e164: '+919876543210' });
    // '+' wins over the default country
    expect(normaliseE164('+1 201-555-0123', 'IN')).toEqual({ ok: true, e164: '+12015550123' });
    // no guessed country: a bare national number under the wrong default is unparsable
    expect(normaliseE164('98765 43210', 'US')).toEqual({ ok: false, reason: 'unparsable' });
    expect(normaliseE164('12345', 'IN')).toEqual({ ok: false, reason: 'unparsable' });
    expect(normaliseE164('', 'IN')).toEqual({ ok: false, reason: 'empty' });
    expect(normaliseE164('   ', 'IN')).toEqual({ ok: false, reason: 'empty' });
    // Delhi landline: valid number, not mobile-plausible
    expect(normaliseE164('+91 11 2345 6789', 'IN')).toEqual({
      ok: false,
      reason: 'not_mobile_plausible',
    });
    expect(normaliseE164('abc', 'IN')).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('a_non_parsable_number_is_a_typed_reason_not_a_thrown_string', () => {
    const inputs = ['abc', '+', '++91', '٠٩٨٧٦٥٤٣٢١٠', 'x'.repeat(500), '+91 98765 43210 ext 5'];
    const validReasons: E164Reason[] = ['empty', 'unparsable', 'not_mobile_plausible'];
    for (const input of inputs) {
      const result = normaliseE164(input, 'IN');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(validReasons).toContain(result.reason);
      }
    }

    expect(() => normaliseE164('98765 43210', 'india')).toThrow(TypeError);
  });

  it('wa_jid_is_derived_only_from_a_normalised_e164', () => {
    expect(waJidFromE164('+919876543210')).toBe('919876543210@s.whatsapp.net');
    expect(() => waJidFromE164('9876543210')).toThrow(TypeError);
  });
});
