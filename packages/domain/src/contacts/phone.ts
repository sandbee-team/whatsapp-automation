import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * phone.ts (P20 Unit U2, step 3) - `normaliseE164`, the ONE function that
 * turns a raw, tenant-supplied phone string into a durable-safe E.164 value
 * or a typed rejection reason. Never guesses: an ambiguous or non-mobile
 * number is rejected, not silently coerced, because a wrong number becomes a
 * durable `contacts` row and later a real send target.
 *
 * Imports from `libphonenumber-js/max` (not `/min`): the `max` metadata
 * carries per-number TYPE information (`getType()`), which `/min` does not -
 * `getType()` would be `undefined` for every number under `/min`, and this
 * module treats `undefined` as `not_mobile_plausible` (conservative), so a
 * `/min` import would silently reject every number.
 */

export type E164Reason = 'empty' | 'unparsable' | 'not_mobile_plausible';

export type E164Result = { ok: true; e164: string } | { ok: false; reason: E164Reason };

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
/** Separators a human might type: spaces, dashes, dots, parentheses, NBSP. */
const SEPARATOR_RE = /[\s\-.()\u00a0]/g;
const LEADING_00_RE = /^00(?=\d)/;
const ASCII_PHONE_CHARS_RE = /^\+?[0-9]+$/;
const PLAUSIBLE_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE']);

/**
 * Normalises `raw` to E.164 under `defaultCountry`, or returns a typed
 * rejection reason - it never throws for bad USER data (only for bad CALLER
 * config, see below), because a raw import row is untrusted input, not a
 * programming error.
 *
 * `defaultCountry` is ISO-3166 alpha-2 (e.g. `'IN'`). An invalid country code
 * is CALLER CONFIG, not user data, so - unlike every other rejection path in
 * this function - it throws `TypeError`. This is the only throw in this
 * module.
 */
export function normaliseE164(raw: string, defaultCountry: string): E164Result {
  const country = defaultCountry.toUpperCase();
  if (!COUNTRY_CODE_RE.test(country)) {
    throw new TypeError(`normaliseE164: invalid ISO-3166 alpha-2 country code: ${defaultCountry}`);
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }

  const stripped = trimmed.replace(SEPARATOR_RE, '');
  const cleaned = stripped.includes('+') ? stripped : stripped.replace(LEADING_00_RE, '+');

  // Conservative: only ASCII `+`/digits reach the parser. Non-ASCII digit
  // scripts (e.g. Arabic-Indic) are silently digit-normalised by
  // libphonenumber-js internally, which would let a non-Latin-script string
  // masquerade as a plausible number - "never guesses" extends to never
  // accepting a script the raw input didn't actually use.
  if (!ASCII_PHONE_CHARS_RE.test(cleaned)) {
    return { ok: false, reason: 'unparsable' };
  }

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(cleaned, country as never);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }

  if (!parsed || !parsed.isValid()) {
    return { ok: false, reason: 'unparsable' };
  }

  const type = parsed.getType();
  if (type === undefined || !PLAUSIBLE_TYPES.has(type)) {
    return { ok: false, reason: 'not_mobile_plausible' };
  }

  return { ok: true, e164: parsed.number };
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Builds the Baileys `@s.whatsapp.net` JID from an already-normalised E.164
 * string. Accepts ONLY the `normaliseE164` output shape - callers never pass
 * raw user input here (that is what `normaliseE164` is for), so a mismatch is
 * a programming error, not user input, hence the throw.
 */
export function waJidFromE164(e164: string): string {
  if (!E164_RE.test(e164)) {
    throw new TypeError(`waJidFromE164: expected a normalised E.164 string, got: ${e164}`);
  }
  return `${e164.slice(1)}@s.whatsapp.net`;
}
