/**
 * platform/http/ip-rules.ts (P15 Unit U3) - pure address classification for
 * the SSRF guard (`safe-fetch.ts`). Owns exactly one question: "is this
 * address (or hostname literal) one `safeFetch` must refuse to dial?" -
 * nothing here performs I/O (no DNS, no sockets), so it is trivially unit
 * testable and reusable from both the pre-dial hostname check and the
 * post-resolution address check.
 *
 * Reference failure this exists to prevent: evolution-api's SSRF check
 * (`webhook.controller.ts:20-23`) was commented out AND only ever evaluated
 * the configured hostname at configuration time, never the address actually
 * dialled - a DNS answer that later resolves the same hostname to an
 * internal address sails straight through. This module is deliberately
 * IP-address-only: every hostname must be resolved and every resolved
 * address classified before a socket opens (see safe-fetch.ts).
 *
 * WHATWG `new URL()` and DNS itself both accept several non-canonical
 * numeric literal encodings for the same IPv4 address - a decimal 32-bit
 * integer (`2130706433` === `127.0.0.1`) and per-octet octal/hex forms
 * (`0177.0.0.1`). Browsers and some HTTP clients normalise these before
 * connecting, which is exactly the "looks safe to a naive string check,
 * dials somewhere else" gap this module closes: `classifyHostnameLiteral`
 * parses the raw hostname text as a possible numeric IPv4 literal
 * independent of `URL`'s own normalisation, and `classifyResolvedAddress`
 * classifies the actual DNS answer. `safeFetch` calls both and denies if
 * EITHER says deny.
 */

export type IpDenyReason =
  | 'loopback'
  | 'link_local'
  | 'private_rfc1918'
  | 'cgnat'
  | 'unspecified'
  | 'ipv6_ula'
  | 'ipv6_loopback'
  | 'ipv6_mapped_denied'
  | 'not_a_public_address'
  // MINOR FIX: additional IANA "Special-Purpose Address Registry" ranges.
  | 'reserved'
  | 'benchmarking'
  | 'multicast'
  | 'broadcast';

export interface IpClassification {
  /** `true` when this address must never be dialled. */
  denied: boolean;
  reason?: IpDenyReason;
}

const ALLOWED: IpClassification = { denied: false };

function denied(reason: IpDenyReason): IpClassification {
  return { denied: true, reason };
}

/** Parses a dotted-quad octet allowing decimal, `0x` hex, and leading-zero octal forms (Node/curl parity). */
function parseOctet(raw: string): number | undefined {
  if (raw.length === 0) return undefined;
  let value: number;
  if (/^0x[0-9a-fA-F]+$/.test(raw)) {
    value = parseInt(raw, 16);
  } else if (/^0[0-7]+$/.test(raw)) {
    value = parseInt(raw, 8);
  } else if (/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    value = parseInt(raw, 10);
  } else {
    return undefined;
  }
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
}

/** Parses `a.b.c.d` (each octet decimal/hex/octal) into four 0-255 bytes, or undefined if not that shape. */
function parseDottedQuad(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(parseOctet);
  if (octets.some((o) => o === undefined)) return undefined;
  return octets as [number, number, number, number];
}

/** Parses a single decimal (or `0x`-hex) 32-bit integer literal - e.g. `2130706433` === `127.0.0.1`. */
function parseIntegerIpv4(hostname: string): [number, number, number, number] | undefined {
  let value: number;
  if (/^0x[0-9a-fA-F]+$/.test(hostname)) {
    value = parseInt(hostname, 16);
  } else if (/^[0-9]+$/.test(hostname) && hostname !== '' && !hostname.includes('.')) {
    value = parseInt(hostname, 10);
  } else {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return undefined;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function classifyIpv4Bytes(bytes: [number, number, number, number]): IpClassification {
  const [a, b, c, d] = bytes;

  if (a === 127) return denied('loopback');
  if (a === 0) return denied('unspecified');
  if (a === 169 && b === 254) return denied('link_local');
  if (a === 10) return denied('private_rfc1918');
  if (a === 172 && b >= 16 && b <= 31) return denied('private_rfc1918');
  if (a === 192 && b === 168) return denied('private_rfc1918');
  if (a === 100 && b >= 64 && b <= 127) return denied('cgnat');
  if (a === 0 && b === 0 && c === 0 && d === 0) return denied('unspecified');
  // MINOR FIX: additional IANA "Special-Purpose Address Registry" ranges -
  // 192.0.0.0/24 (IETF Protocol Assignments), 198.18.0.0/15 (benchmarking),
  // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved, "future use"), and the
  // limited-broadcast address 255.255.255.255 (checked before the /4
  // reserved range so it reports its own more specific reason).
  if (a === 255 && b === 255 && c === 255 && d === 255) return denied('broadcast');
  if (a === 192 && b === 0 && c === 0) return denied('reserved');
  if (a === 198 && (b === 18 || b === 19)) return denied('benchmarking');
  if (a >= 224 && a <= 239) return denied('multicast');
  if (a >= 240) return denied('reserved');

  return ALLOWED;
}

/** Classifies a raw IPv4 dotted-quad string (already known to be plain decimal dotted-quad, e.g. from DNS). */
export function classifyIpv4(address: string): IpClassification {
  const bytes = parseDottedQuad(address);
  if (bytes === undefined) return denied('not_a_public_address');
  return classifyIpv4Bytes(bytes);
}

const IPV6_LOOPBACK = '::1';

/**
 * MINOR FIX: matches BOTH the `::`-compressed form (`::ffff:...`) AND the
 * fully-expanded, non-`::`-anchored form (`0:0:0:0:0:ffff:...`) - a
 * resolver/parser is free to return either representation for the same
 * address, and the compressed-only anchor previously left the expanded form
 * entirely unclassified as a mapped address (falling through to the
 * ordinary IPv6 rules, which do not know about the embedded IPv4 payload at
 * all).
 */
const IPV4_MAPPED_PREFIX = /^(?:::|0:0:0:0:0:)ffff:/;

function isIpv4MappedIpv6(address: string): [number, number, number, number] | undefined {
  const lower = address.toLowerCase();
  const match = new RegExp(
    `${IPV4_MAPPED_PREFIX.source}(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})$`,
  ).exec(lower);
  if (match?.[1] !== undefined) {
    return parseDottedQuad(match[1]);
  }
  // ::ffff:7f00:1 / 0:0:0:0:0:ffff:7f00:1 (hex-group form of the mapped address).
  const hexMatch = new RegExp(`${IPV4_MAPPED_PREFIX.source}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`).exec(
    lower,
  );
  if (hexMatch?.[1] !== undefined && hexMatch[2] !== undefined) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
  }
  return undefined;
}

/** Classifies a raw IPv6 address string (as returned by `dns.lookup`/`net.isIP` family 6). */
export function classifyIpv6(address: string): IpClassification {
  const lower = address.toLowerCase();

  if (lower === IPV6_LOOPBACK) return denied('ipv6_loopback');
  if (lower === '::') return denied('unspecified');

  const mapped = isIpv4MappedIpv6(address);
  if (mapped !== undefined) {
    const inner = classifyIpv4Bytes(mapped);
    return inner.denied ? denied('ipv6_mapped_denied') : ALLOWED;
  }

  // Link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return denied('link_local');
  // Unique local fc00::/7 (fc00.. or fd00..).
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return denied('ipv6_ula');

  return ALLOWED;
}

/** Family-agnostic classification of a resolved DNS answer address. */
export function classifyResolvedAddress(address: string, family: 4 | 6): IpClassification {
  return family === 4 ? classifyIpv4(address) : classifyIpv6(address);
}

/**
 * Classifies the RAW hostname text of a URL as a possible numeric IPv4
 * literal (dotted-quad with octal/hex octets, or a bare 32-bit integer) -
 * independent of whatever `new URL()` already normalised it to. Returns
 * `{ denied: false }` for anything that is not a recognised numeric IPv4
 * literal shape (i.e. an ordinary DNS name), since those are judged solely
 * by their resolved address instead.
 */
export function classifyHostnameLiteral(hostname: string): IpClassification {
  const bareHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (bareHost.includes(':')) {
    return classifyIpv6(bareHost);
  }

  const dottedQuad = parseDottedQuad(bareHost);
  if (dottedQuad !== undefined) {
    return classifyIpv4Bytes(dottedQuad);
  }

  const integerForm = parseIntegerIpv4(bareHost);
  if (integerForm !== undefined) {
    return classifyIpv4Bytes(integerForm);
  }

  return ALLOWED;
}
