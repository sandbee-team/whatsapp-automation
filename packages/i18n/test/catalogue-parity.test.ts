import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '../src/catalogues/en.js';
import { hi } from '../src/catalogues/hi.js';
import { createT, getMissingKeyCount, resetMissingKeyCounter, t } from '../src/t.js';
import type { Catalogue } from '../src/catalogues/catalogue-type.js';

/**
 * Catalogue-parity + t() proof (P05 step 2, design doc `@wp/i18n` section).
 */

beforeEach(() => {
  resetMissingKeyCounter();
});

describe('en/hi catalogue parity', () => {
  it('en_and_hi_have_identical_key_sets', () => {
    const enKeys = new Set(Object.keys(en));
    const hiKeys = new Set(Object.keys(hi));

    const onlyInEn = [...enKeys].filter((key) => !hiKeys.has(key));
    const onlyInHi = [...hiKeys].filter((key) => !enKeys.has(key));

    expect(onlyInEn, `keys present in en but missing from hi: ${onlyInEn.join(', ')}`).toEqual([]);
    expect(onlyInHi, `keys present in hi but missing from en: ${onlyInHi.join(', ')}`).toEqual([]);
  });
});

describe('t() missing-key fallback', () => {
  it('a_missing_key_falls_back_to_english_and_counts_it', () => {
    const partialHi: Catalogue = { ...hi };
    delete (partialHi as Record<string, string>)['nav.logout'];

    const scopedT = createT({ en, hi: partialHi });

    expect(getMissingKeyCount()).toBe(0);
    const result = scopedT('nav.logout' as never, undefined, 'hi');
    expect(result).toBe(en['nav.logout']);
    expect(getMissingKeyCount()).toBe(1);
  });

  it('a_key_missing_from_both_catalogues_returns_the_key_itself_and_never_throws', () => {
    const emptyCatalogue: Catalogue = {};
    const scopedT = createT({ en: emptyCatalogue, hi: emptyCatalogue });

    expect(() => scopedT('nav.logout' as never, undefined, 'hi')).not.toThrow();
    expect(scopedT('nav.logout' as never, undefined, 'hi')).toBe('nav.logout');
  });

  it('the_real_t_export_returns_english_strings_by_default', () => {
    expect(t('nav.logout')).toBe(en['nav.logout']);
    expect(t('nav.logout', undefined, 'hi')).toBe(hi['nav.logout']);
  });
});

describe('t() interpolation', () => {
  it('interpolation_replaces_known_placeholders_only', () => {
    const result = t('auth.recovery.hint', { name: 'Acme Co' });
    expect(result).toBe('Enter the recovery code for Acme Co.');

    // Unknown placeholder left literally.
    const scopedT = createT({
      en: { 'x.y': 'Hello {name}, your {unknown} is ready.' },
      hi: { 'x.y': 'Hello {name}, your {unknown} is ready.' },
    });
    expect(scopedT('x.y' as never, { name: 'Sam' })).toBe('Hello Sam, your {unknown} is ready.');
  });

  it('a_var_value_itself_containing_a_brace_is_substituted_literally_and_never_re_interpolated', () => {
    const scopedT = createT({
      en: { 'x.y': 'Value: {value}' },
      hi: { 'x.y': 'Value: {value}' },
    });
    // The substituted value contains "{other}" - this must NOT be expanded
    // as a second placeholder pass (single-pass replace via String.replace's
    // callback form already guarantees this, but it is worth pinning).
    expect(scopedT('x.y' as never, { value: '{other}' })).toBe('Value: {other}');
  });

  it('an_empty_key_never_throws_and_returns_the_key_itself_when_missing_everywhere', () => {
    const scopedT = createT({ en: {}, hi: {} });
    expect(() => scopedT('' as never)).not.toThrow();
    expect(scopedT('' as never)).toBe('');
  });

  it('an_unknown_locale_string_falls_back_to_english_rather_than_throwing', () => {
    // `Locale` is a closed union at the type level, but nothing stops a
    // runtime caller (e.g. a locale read from a cookie/header) from passing
    // an unrecognised string - this must degrade to the English fallback
    // path, not throw on `localeCatalogue[key]` against `undefined`.
    const scopedT = createT({ en: { 'x.y': 'hello' }, hi: { 'x.y': 'namaste' } });
    expect(() => scopedT('x.y' as never, undefined, 'fr' as never)).not.toThrow();
    expect(scopedT('x.y' as never, undefined, 'fr' as never)).toBe('hello');
  });

  it('vars_is_undefined_and_the_template_has_placeholders_leaves_them_literal', () => {
    const scopedT = createT({
      en: { 'x.y': 'Hello {name}' },
      hi: { 'x.y': 'Hello {name}' },
    });
    expect(scopedT('x.y' as never)).toBe('Hello {name}');
  });
});
