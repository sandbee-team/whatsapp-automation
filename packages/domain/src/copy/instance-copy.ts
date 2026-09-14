/**
 * Verbatim user-facing copy for the parked/instance-health surfaces (P08
 * session/QR-linking, ADR 0018 §1) plus the phone-masking helper shared by
 * every panel surface that shows a connected number.
 */

/**
 * Source: ADR 0018 §1, verbatim (em-dash exactly as here - do not replace
 * with a hyphen or `--`). `scripts/check-copy.ts`-style consumers depend on
 * byte-for-byte equality, so this is a single-quoted string, not reformatted.
 */
export const PARKED_COPY =
  'Parked — not connected. This number is not receiving messages while parked. Messages people send you during this time may not appear after you reconnect. Queued messages are safe and will send when you reconnect.';

/**
 * Honest caveat about WhatsApp's own undocumented server-side offline
 * buffer - never overstates what WP can guarantee about messages sent to a
 * parked number (invariant 6, no false reliability promises).
 */
export const PARKED_BUFFER_CAVEAT =
  "WhatsApp's server-side buffer for an offline linked device is neither documented nor unlimited — we don't know how much is retained or for how long.";

const MIDDLE_MASK = '·····';

/**
 * Country-calling-code lengths this heuristic recognizes explicitly (longest
 * match wins) - covers the common 1-digit (NANP, Russia/Kazakhstan) and a
 * representative set of 2- and 3-digit codes. Anything not matched here
 * falls back to a conservative 2-digit assumption, which is the most common
 * length worldwide (ITU E.164 country codes are 1-3 digits).
 */
const ONE_DIGIT_CODES = new Set(['1', '7']);
const THREE_DIGIT_CODES = new Set([
  '971',
  '966',
  '974',
  '965',
  '968',
  '973',
  '962',
  '961',
  '963',
  '960',
  '880',
  '886',
  '852',
  '853',
  '855',
  '856',
  '675',
  '676',
]);

function countryCodeLength(digits: string): number {
  const first1 = digits.slice(0, 1);
  const first3 = digits.slice(0, 3);
  if (THREE_DIGIT_CODES.has(first3)) return 3;
  if (ONE_DIGIT_CODES.has(first1)) return 1;
  return 2;
}

/**
 * Masks an E.164 phone number to the shape `+91·····21`: keeps the leading
 * `+`, the country-code digits (1-3), exactly five middle dots, and the last
 * two digits. The full number is never derivable from the output - the
 * masked string never contains more digits than country-code-length + 2.
 */
export function maskPhoneE164(e164: string): string {
  const digits = e164.replace(/\D/gu, '');
  const ccLen = Math.min(countryCodeLength(digits), Math.max(0, digits.length - 2));
  const countryCode = digits.slice(0, ccLen);
  const lastTwo = digits.slice(-2);
  return `+${countryCode}${MIDDLE_MASK}${lastTwo}`;
}
