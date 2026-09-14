import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_TOKEN_RE,
  extractTemplateTokens,
  freezeVars,
  renderVars,
  missingVarSkipReason,
} from '../src/broadcast/vars.js';

/**
 * broadcast-vars.test.ts (P23 Unit U2, step 3) - template token extraction,
 * freeze-at-snapshot resolution, and render-from-frozen-vars-only
 * substitution. The core invariant under test: a missing variable is caught
 * at snapshot time (never renders as an empty string, ever) - see
 * `a_missing_variable_skips_at_snapshot_time_and_never_renders_empty` below.
 */

describe('TEMPLATE_TOKEN_RE / extractTemplateTokens', () => {
  it('extracts_a_simple_token', () => {
    expect(extractTemplateTokens('Hi {{name}}, welcome.')).toEqual(['name']);
  });

  it('tolerates_inner_whitespace', () => {
    expect(extractTemplateTokens('Hi {{  name  }}!')).toEqual(['name']);
  });

  it('dedupes_repeated_tokens_keeping_first_order', () => {
    expect(extractTemplateTokens('{{name}} and {{name}} again, {{city}}')).toEqual([
      'name',
      'city',
    ]);
  });

  it('supports_dotted_attribute_paths', () => {
    expect(extractTemplateTokens('Hello from {{attrs.city}}')).toEqual(['attrs.city']);
  });

  it('returns_empty_array_for_no_tokens', () => {
    expect(extractTemplateTokens('No placeholders here.')).toEqual([]);
  });

  it('does_not_match_a_single_brace', () => {
    expect(extractTemplateTokens('This {is not} a token')).toEqual([]);
  });
});

describe('freezeVars', () => {
  it('a_missing_variable_skips_at_snapshot_time_and_never_renders_empty', () => {
    const result = freezeVars('Hi {{name}}, from {{city}}', { name: 'Sam' });
    expect(result).toEqual({ ok: false, missingToken: 'city' });
    expect(missingVarSkipReason('city')).toBe('missing_var:city');

    // renderVars must also refuse - vars never carries the missing token,
    // and rendering must never substitute a blank for it.
    const rendered = renderVars('Hi {{name}}, from {{city}}', { name: 'Sam' });
    expect(rendered).toEqual({ ok: false, missingToken: 'city' });
  });

  it('resolves_a_present_string_value', () => {
    const result = freezeVars('Hi {{name}}', { name: 'Priya' });
    expect(result).toEqual({ ok: true, vars: { name: 'Priya' } });
  });

  it('resolves_a_finite_number_value_stringified', () => {
    const result = freezeVars('Order #{{orderNumber}}', { orderNumber: 42 });
    expect(result).toEqual({ ok: true, vars: { orderNumber: '42' } });
  });

  it('treats_an_empty_string_value_as_missing', () => {
    const result = freezeVars('Hi {{name}}', { name: '' });
    expect(result).toEqual({ ok: false, missingToken: 'name' });
  });

  it('resolves_a_nested_dotted_attribute_path', () => {
    const result = freezeVars('From {{attrs.city}}', { attrs: { city: 'Pune' } });
    expect(result).toEqual({ ok: true, vars: { 'attrs.city': 'Pune' } });
  });

  it('returns_the_first_missing_token_when_multiple_are_missing', () => {
    const result = freezeVars('{{a}} {{b}} {{c}}', { c: 'ok' });
    expect(result).toEqual({ ok: false, missingToken: 'a' });
  });

  it('non_finite_number_values_count_as_missing', () => {
    const result = freezeVars('{{score}}', { score: Number.NaN });
    expect(result).toEqual({ ok: false, missingToken: 'score' });
  });

  it('a_body_with_no_tokens_resolves_to_an_empty_vars_object', () => {
    const result = freezeVars('No tokens at all', {});
    expect(result).toEqual({ ok: true, vars: {} });
  });

  it('whitespace_tolerant_repeated_tokens_all_resolve_from_one_source_key', () => {
    const result = freezeVars('{{ name }} and {{name}}', { name: 'Kabir' });
    expect(result).toEqual({ ok: true, vars: { name: 'Kabir' } });
  });
});

describe('renderVars', () => {
  it('substitutes_only_from_the_frozen_vars_map', () => {
    const result = renderVars('Hi {{name}}, from {{city}}', {
      name: 'Sam',
      city: 'Delhi',
    });
    expect(result).toEqual({ ok: true, text: 'Hi Sam, from Delhi' });
  });

  it('never_substitutes_an_empty_string_even_if_present_in_vars', () => {
    const result = renderVars('Hi {{name}}', { name: '' });
    expect(result).toEqual({ ok: false, missingToken: 'name' });
  });

  it('does_not_read_from_a_template_or_contact_source_only_from_vars', () => {
    // vars deliberately omits 'city' even though a caller might have a
    // contact record with a city field lying around - render must not reach
    // for it.
    const result = renderVars('{{city}}', {});
    expect(result).toEqual({ ok: false, missingToken: 'city' });
  });

  it('renders_repeated_tokens_from_the_same_vars_entry', () => {
    const result = renderVars('{{name}}-{{name}}', { name: 'Zoe' });
    expect(result).toEqual({ ok: true, text: 'Zoe-Zoe' });
  });
});

describe('missingVarSkipReason', () => {
  it('formats_the_reason_with_the_token', () => {
    expect(missingVarSkipReason('attrs.city')).toBe('missing_var:attrs.city');
  });
});

describe('TEMPLATE_TOKEN_RE export sanity', () => {
  it('matches_the_documented_token_charset', () => {
    expect(TEMPLATE_TOKEN_RE.test('{{Valid_Token1}}')).toBe(true);
    expect(TEMPLATE_TOKEN_RE.test('{{1invalid}}')).toBe(false);
  });
});
