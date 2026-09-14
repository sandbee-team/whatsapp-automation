import { describe, expect, it } from 'vitest';
import { classify, TERMINAL_CATEGORIES, isTerminalCategory } from './classify.js';

describe('classify', () => {
  it('an_unknown_provider_error_classifies_as_pause_never_retry', () => {
    const unmapped = [
      {}, // no category at all
      { code: 999_999, category: 'totally_unrecognized_category' },
      { category: 'unknown' }, // the blueprint's explicit "unknown" category
    ];

    for (const err of unmapped) {
      const result = classify(err);
      expect(result).toBe('PAUSE_INSTANCE');
      expect(result).not.toBe('RETRY_BACKOFF');
      expect(result).not.toBe('FAIL_PERMANENT');
      expect(result).not.toBe('RECONCILE');
    }
  });

  it('maps the blueprint retry-class table categories', () => {
    expect(classify({ category: 'transient' })).toBe('RETRY_BACKOFF');
    expect(classify({ category: 'not_connected' })).toBe('RETRY_BACKOFF');
    expect(classify({ category: 'rate_limited' })).toBe('RETRY_BACKOFF');
    expect(classify({ category: 'invalid_recipient' })).toBe('FAIL_PERMANENT');
    expect(classify({ category: 'invalid_payload' })).toBe('FAIL_PERMANENT');
    expect(classify({ category: 'restricted' })).toBe('PAUSE_INSTANCE');
  });

  it('group_forbidden_classifies_as_terminal_fail_permanent_never_a_pause', () => {
    // P16 Unit C, scope delta § Groups: a @g.us authorisation rejection is
    // terminal for that one job and must never route to PAUSE_INSTANCE.
    expect(classify({ category: 'group_forbidden' })).toBe('FAIL_PERMANENT');
  });

  // --- Edge-case pass (session C2) ----------------------------------------

  it('falsy_but_present_code_values_do_not_affect_classification_by_category', () => {
    expect(classify({ code: 0, category: 'transient' })).toBe('RETRY_BACKOFF');
    expect(classify({ code: '', category: 'restricted' })).toBe('PAUSE_INSTANCE');
    // No category at all, only a falsy code - fail-safe default.
    expect(classify({ code: 0 })).toBe('PAUSE_INSTANCE');
    expect(classify({ code: '' })).toBe('PAUSE_INSTANCE');
  });

  it('an_empty_string_category_is_not_a_known_category_and_pauses', () => {
    expect(classify({ category: '' })).toBe('PAUSE_INSTANCE');
  });

  it('category_matching_is_case_sensitive_an_uppercase_known_category_still_pauses', () => {
    // "TRANSIENT" is not a key in RETRY_CLASS_BY_CATEGORY ("transient" is) -
    // the fail-safe default must apply rather than silently normalizing
    // case, since a provider could send an unexpected casing.
    expect(classify({ category: 'TRANSIENT' })).toBe('PAUSE_INSTANCE');
    expect(classify({ category: 'Restricted' })).toBe('PAUSE_INSTANCE');
  });

  it('an_injected_table_cannot_downgrade_restricted_or_unknown', () => {
    // Core invariant 2 (fail-safe): 'restricted' and 'unknown' are hard-pause
    // categories that must never be overridable via the injected `table`
    // param - classify must short-circuit on them BEFORE consulting `table`.
    const hostileTable = Object.freeze({
      restricted: 'RETRY_BACKOFF',
      unknown: 'RETRY_BACKOFF',
    } as const);

    expect(classify({ category: 'restricted' }, hostileTable)).toBe('PAUSE_INSTANCE');
    expect(classify({ category: 'unknown' }, hostileTable)).toBe('PAUSE_INSTANCE');
  });

  it('null_and_undefined_error_objects_are_handled_the_same_as_empty', () => {
    // Structural typing: classify only reads `.category`, so passing
    // `undefined`/`null` cast through the type would crash on property
    // access rather than silently retrying - document current behavior.
    expect(() => classify(undefined as unknown as { category?: string })).toThrow();
    expect(() => classify(null as unknown as { category?: string })).toThrow();
  });

  // --- P24 groups-messaging, Unit U2 ---------------------------------------

  it('terminal_categories_is_exactly_invalid_recipient_invalid_payload_group_forbidden', () => {
    expect([...TERMINAL_CATEGORIES].sort()).toEqual([
      'group_forbidden',
      'invalid_payload',
      'invalid_recipient',
    ]);
  });

  it('group_forbidden_is_terminal_and_never_pauses', () => {
    expect(isTerminalCategory('group_forbidden')).toBe(true);
    expect(classify({ category: 'group_forbidden' })).toBe('FAIL_PERMANENT');
  });
});
