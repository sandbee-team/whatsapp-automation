/**
 * Content fingerprint normalisation (P14 Unit U2, phase step 3).
 *
 * Produces a STRING, never a hash - hashing needs `node:crypto` and happens
 * server-side in a later unit (this package is browser-pure, no Node APIs).
 * The goal is a canonical form where cosmetic/per-recipient variation
 * (links, numbers, resolved template values, emoji, whitespace) collapses
 * to the same string for two messages that are "the same broadcast content"
 * to a human, so a later server-side hash of this string can dedupe/rate-
 * limit near-identical sends. Template PLACEHOLDER SYNTAX (`{{name}}`) is
 * stripped because it never varies the underlying template; the RESOLVED
 * value that replaces it (e.g. "Rahul") is ordinary text and is
 * deliberately left alone - stripping resolved values would collapse two
 * genuinely different messages into the same fingerprint.
 */
import { LINK_RE } from './link-regex.js';

const TEMPLATE_PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;
const DIGIT_RUN_RE = /\d+/g;
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
// Zero-width joiner and variation selector-16, each matched by its own
// single-codepoint regex: ESLint's no-misleading-character-class flags a
// combining codepoint placed alongside ANY other codepoint in one class.
const ZERO_WIDTH_JOINER_RE = /\u{200D}/gu;
const VARIATION_SELECTOR_16_RE = /\u{FE0F}/gu;

export function normaliseForFingerprint(body: string): string {
  return body
    .toLowerCase()
    .replace(TEMPLATE_PLACEHOLDER_RE, '')
    .replace(LINK_RE, '<url>')
    .replace(DIGIT_RUN_RE, '#')
    .replace(EMOJI_RE, ' ')
    .replace(ZERO_WIDTH_JOINER_RE, ' ')
    .replace(VARIATION_SELECTOR_16_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
