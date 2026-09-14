/**
 * Link detection (P14 Unit U2, phase step 3 / content guards).
 *
 * Calibrated to catch the forms tenants actually use to smuggle links past
 * a naive "http(s)://" check - `www.` hosts, bare shortener domains, bare
 * `t.me/`/`wa.me/` deep-links, and a generic `host.tld/path` shape - while
 * NOT flagging ordinary prose that merely contains dots: abbreviations
 * ("e.g."), honorifics ("Mr."), times ("5.30"), and version numbers
 * ("2.5.1"). The generic bare-host clause requires BOTH a plausible TLD
 * (2-24 letters) AND a following `/path` segment - a bare `word.word` with
 * no path (e.g. "something.else") never matches, which is what keeps "e.g.
 * tomorrow" and "5.30" out: neither has a `/` after the dot-suffix.
 */

const SCHEME_URL = String.raw`(?:https?:\/\/[^\s]+)`;
const WWW_HOST = String.raw`(?:www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)`;
const TELEGRAM_WA_DEEPLINK = String.raw`(?:\b(?:t\.me|wa\.me)\/[^\s]+)`;
const KNOWN_SHORTENERS = [
  'bit\\.ly',
  'tinyurl\\.com',
  'goo\\.gl',
  't\\.co',
  'cutt\\.ly',
  'rb\\.gy',
  'is\\.gd',
];
const SHORTENER_HOST = String.raw`(?:\b(?:${KNOWN_SHORTENERS.join('|')})\/[^\s]*)`;
// Bare `host.tld/path`: requires a path segment after the TLD so ordinary
// prose with dots (no trailing slash+path) never matches.
const BARE_HOST_WITH_PATH = String.raw`(?:\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s]*)`;

export const LINK_RE = new RegExp(
  [SCHEME_URL, WWW_HOST, TELEGRAM_WA_DEEPLINK, SHORTENER_HOST, BARE_HOST_WITH_PATH].join('|'),
  'gi',
);

export function containsLink(text: string): boolean {
  LINK_RE.lastIndex = 0; // stateful global regex - always reset before use
  return LINK_RE.test(text);
}
