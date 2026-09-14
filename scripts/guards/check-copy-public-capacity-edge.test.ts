import { describe, expect, it } from 'vitest';
import { BROADCAST_DISCLOSURE } from '@wp/domain';
import { scanCopy } from '../check-copy.js';
import {
  gateCSentence,
  readMeasuredN,
  scanPublicCapacityClaims,
} from './copy-public-capacity-lib.js';

/**
 * check-copy-public-capacity-edge.test.ts (P29 session 1, E3 hardening) -
 * false-positive resistance and boundary cases for clause (e) beyond
 * `check-copy-website.test.ts`: benign numeric copy that must NOT trip the
 * guard, `readMeasuredN` edge inputs, an NBSP-joined figure, and the
 * multi-figure-per-line case.
 */

const PUBLIC_PATH = 'website/src/content/copy/example.ts';

describe('clause_e_false_positive_resistance', () => {
  it('the_broadcast_disclosure_constant_itself_produces_zero_clause_e_violations', () => {
    const violations = scanPublicCapacityClaims(
      { path: PUBLIC_PATH, content: BROADCAST_DISCLOSURE },
      '1,000',
    );
    expect(violations).toEqual([]);
  });

  it('generic_non_capacity_numeric_copy_produces_zero_violations', () => {
    const benignLines = [
      '24/7 support is available',
      'built on v1 of the API',
      'get started in 3 steps',
      'launched in 2026',
      'up to 200 characters',
      'takes about 60 seconds',
    ];
    for (const line of benignLines) {
      const violations = scanPublicCapacityClaims({ path: PUBLIC_PATH, content: line }, '1,000');
      expect(violations, `expected no violation for "${line}"`).toEqual([]);
    }
  });

  it('an_nbsp_joined_capacity_figure_is_caught_v8_regex_backslash_s_already_matches_nbsp', () => {
    // A real non-breaking space (code point 160) between the number and
    // the unit, built with String.fromCharCode so the source file itself
    // carries no literal NBSP byte (which would trip this repo's own
    // irregular-whitespace lint rule): `s` in a `u`/`v`-flag-free JS regex
    // already matches U+00A0 (ECMA-262 WhiteSpace includes NBSP), so this
    // is exercised as a real assertion, not skipped as a documented gap.
    const nbsp = String.fromCharCode(160);
    const nbspLine = `quotes 2,000${nbsp}sessions of capacity`;
    const violations = scanPublicCapacityClaims({ path: PUBLIC_PATH, content: nbspLine }, '1,000');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('fullwidth_digits_are_a_documented_non_goal_not_tested', () => {
    // Fullwidth digit variants (U+FF10-FF19, e.g. "２，０００") are outside
    // this guard's `\d` character class and are a documented non-goal per
    // the dispatch brief - no assertion is made either way here.
    expect(true).toBe(true);
  });

  it('a_gate_c_sentence_with_a_different_n_sharing_a_line_with_another_figure_is_still_a_violation', () => {
    const line = `${gateCSentence('5,000')} and also handles 10,000 concurrent sessions`;
    const violations = scanPublicCapacityClaims({ path: PUBLIC_PATH, content: line }, '1,000');
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('read_measured_n_edge_cases', () => {
  it('returns_the_first_of_two_measured_n_lines', () => {
    const doc = 'Measured N = 1,000\nsome text\nMeasured N = 9,999';
    expect(readMeasuredN(doc)).toBe('1,000');
  });

  it('returns_undefined_for_an_empty_document', () => {
    expect(readMeasuredN('')).toBeUndefined();
  });
});

describe('clause_e_scope', () => {
  it('a_non_public_path_with_the_same_lines_yields_nothing_even_when_claims_is_empty', () => {
    const violations = scanCopy(
      [{ path: 'docs/internal/capacity-notes.md', content: 'handles 10,000 concurrent sessions' }],
      [],
    );
    expect(violations).toEqual([]);
  });
});
